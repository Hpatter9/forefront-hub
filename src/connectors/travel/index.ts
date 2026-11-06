import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { Config } from "../../core/config.js";

/**
 * Drive times between addresses, for "leave by" times on calendar events.
 * - osm (default, no setup): OpenStreetMap's Nominatim to find the address and the public OSRM router for the
 *   drive. No live traffic, so the hub pads it (see TRAFFIC_PAD). Light use only: one look-up per new address,
 *   cached in .hub/travel.json.
 * - google (GOOGLE_MAPS_API_KEY in .env): Google's Routes API with live and predicted traffic for the time you'd
 *   leave. Needs the Routes API switched on in the same Google Cloud project as Gmail.
 */
export interface Drive {
  minutes: number;
  miles: number;
  /** True when the time accounts for traffic at the departure time. */
  traffic: boolean;
}

export interface TravelClient {
  readonly kind: "osm" | "google" | "mock";
  /** Driving time from one address to another, leaving around `departAt`. Null when either address can't be found. */
  drive(from: string, to: string, departAt?: Date): Promise<Drive | null>;
}

/** OSRM's times assume empty roads; metro driving runs about this much longer. */
export const TRAFFIC_PAD = 1.2;

type Cache = { geo: Record<string, [number, number] | null>; route: Record<string, { s: number; m: number; at: string }> };

abstract class Cached {
  private file: string;
  protected cache: Cache;
  constructor(stateDir: string) {
    this.file = path.join(stateDir, "travel.json");
    try {
      this.cache = existsSync(this.file) ? JSON.parse(readFileSync(this.file, "utf8")) : { geo: {}, route: {} };
    } catch {
      this.cache = { geo: {}, route: {} };
    }
  }
  protected save() {
    mkdirSync(path.dirname(this.file), { recursive: true });
    writeFileSync(this.file, JSON.stringify(this.cache));
  }
}

const norm = (a: string) => a.replace(/\s+/g, " ").trim().toLowerCase();
const UA = "ForefrontHub/1.0 (personal work hub; light use)";

export class OsmTravel extends Cached implements TravelClient {
  readonly kind = "osm" as const;
  private lastGeo = 0;

  /** Nominatim allows one request a second; addresses are cached for good. */
  async geocode(address: string): Promise<[number, number] | null> {
    const k = norm(address);
    if (k in this.cache.geo) return this.cache.geo[k];
    const wait = this.lastGeo + 1100 - Date.now();
    if (wait > 0) await new Promise((r) => setTimeout(r, wait));
    this.lastGeo = Date.now();
    const u = `https://nominatim.openstreetmap.org/search?${new URLSearchParams({ format: "json", limit: "1", countrycodes: "us", q: address })}`;
    const r = await fetch(u, { headers: { "User-Agent": UA, Accept: "application/json" } });
    if (!r.ok) throw new Error(`Address look-up failed (${r.status})`);
    const hit = ((await r.json()) as { lat: string; lon: string }[])[0];
    this.cache.geo[k] = hit ? [Number(hit.lon), Number(hit.lat)] : null;
    this.save();
    return this.cache.geo[k];
  }

  async drive(from: string, to: string): Promise<Drive | null> {
    const key = `${norm(from)}|${norm(to)}`;
    const hit = this.cache.route[key];
    if (hit && Date.now() - Date.parse(hit.at) < 30 * 86400_000) return { minutes: Math.round((hit.s * TRAFFIC_PAD) / 60), miles: hit.m, traffic: false };
    const [a, b] = [await this.geocode(from), await this.geocode(to)];
    if (!a || !b) return null;
    const r = await fetch(`https://router.project-osrm.org/route/v1/driving/${a.join(",")};${b.join(",")}?overview=false`, { headers: { "User-Agent": UA } });
    if (!r.ok) throw new Error(`Route look-up failed (${r.status})`);
    const j = (await r.json()) as { code: string; routes?: { duration: number; distance: number }[] };
    const route = j.routes?.[0];
    if (j.code !== "Ok" || !route) return null;
    this.cache.route[key] = { s: route.duration, m: Math.round((route.distance / 1609.34) * 10) / 10, at: new Date().toISOString() };
    this.save();
    return { minutes: Math.round((route.duration * TRAFFIC_PAD) / 60), miles: this.cache.route[key].m, traffic: false };
  }
}

export class GoogleTravel extends Cached implements TravelClient {
  readonly kind = "google" as const;
  constructor(stateDir: string, private key: string) {
    super(stateDir);
  }

  async drive(from: string, to: string, departAt?: Date): Promise<Drive | null> {
    // Traffic changes through the day: cache per 30-minute departure slot.
    const when = departAt && departAt.getTime() > Date.now() ? departAt : undefined;
    const slot = when ? Math.floor(when.getTime() / 1_800_000) : "now";
    const key = `g|${norm(from)}|${norm(to)}|${slot}`;
    const hit = this.cache.route[key];
    if (hit && Date.now() - Date.parse(hit.at) < 6 * 3600_000) return { minutes: Math.round(hit.s / 60), miles: hit.m, traffic: true };
    const r = await fetch("https://routes.googleapis.com/directions/v2:computeRoutes", {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Goog-Api-Key": this.key, "X-Goog-FieldMask": "routes.duration,routes.distanceMeters" },
      body: JSON.stringify({ origin: { address: from }, destination: { address: to }, travelMode: "DRIVE", routingPreference: "TRAFFIC_AWARE", ...(when ? { departureTime: when.toISOString() } : {}) }),
    });
    if (!r.ok) throw new Error(`Google Routes: ${r.status} ${(await r.text()).slice(0, 200)}`);
    const route = ((await r.json()) as { routes?: { duration?: string; distanceMeters?: number }[] }).routes?.[0];
    if (!route?.duration) return null;
    const s = Number.parseInt(route.duration, 10);
    this.cache.route[key] = { s, m: Math.round(((route.distanceMeters ?? 0) / 1609.34) * 10) / 10, at: new Date().toISOString() };
    this.save();
    return { minutes: Math.round(s / 60), miles: this.cache.route[key].m, traffic: true };
  }
}

/** Fixed, made-up drive times for tests: 10 minutes plus one per character of difference in the street number. */
export class MockTravel implements TravelClient {
  readonly kind = "mock" as const;
  calls: { from: string; to: string }[] = [];
  async drive(from: string, to: string): Promise<Drive | null> {
    this.calls.push({ from, to });
    if (/nowhere/i.test(to)) return null;
    const n = (s: string) => Number(s.match(/\d+/)?.[0] ?? 0);
    const minutes = 10 + (Math.abs(n(from) - n(to)) % 40);
    return { minutes, miles: Math.round(minutes * 0.6 * 10) / 10, traffic: false };
  }
}

export function makeTravel(cfg: Config): TravelClient {
  if (cfg.mode === "mock") return new MockTravel();
  return cfg.travel.googleKey ? new GoogleTravel(cfg.stateDir, cfg.travel.googleKey) : new OsmTravel(cfg.stateDir);
}
