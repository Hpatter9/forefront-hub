import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { Config } from "../../core/config.js";

/**
 * Drive times between addresses, for "leave by" times on calendar events. Free, no account or key:
 * OpenStreetMap's Nominatim finds the address and the public OSRM router times the drive. OSRM assumes empty
 * roads, so Keystone pads it, more at rush hour (see padFor). Light use only: one look-up per new address and
 * per pair of addresses, kept in .hub/travel.json.
 */
export interface Drive {
  minutes: number;
  miles: number;
  /** True when the time is padded for rush hour. */
  rush: boolean;
}

export interface TravelClient {
  readonly kind: "osm" | "mock";
  /** Driving time from one address to another, leaving around `departAt`. Null when either address can't be found. */
  drive(from: string, to: string, departAt?: Date): Promise<Drive | null>;
  /** Addresses and places that start the way `q` does, nearest the Front Range first (for a Location box). */
  suggest?(q: string): Promise<string[]>;
}

/** One line for a place from Photon (OpenStreetMap's type-ahead search): "2830 S Vine St, Denver, CO 80210". */
export function placeLabel(p: { name?: string; housenumber?: string; street?: string; city?: string; town?: string; village?: string; county?: string; state?: string; postcode?: string }): string {
  const STATES: Record<string, string> = { Colorado: "CO", Wyoming: "WY", Kansas: "KS", Nebraska: "NE", "New Mexico": "NM", Utah: "UT" };
  const street = [p.housenumber, p.street].filter(Boolean).join(" ");
  const city = p.city || p.town || p.village || "";
  const state = [STATES[p.state ?? ""] ?? p.state, p.postcode].filter(Boolean).join(" ");
  const named = p.name && p.name !== p.street && p.name !== city ? p.name : "";
  return [named, street, city || (street ? "" : p.county), state].filter(Boolean).join(", ");
}

/** OSRM's times assume empty roads. Metro driving runs about 20% longer, and about 45% at rush hour. */
export const TRAFFIC_PAD = 1.2;
export const RUSH_PAD = 1.45;

/** Weekday 6:30-9:00 AM and 3:30-6:30 PM, Denver time. */
export function isRushHour(at: Date): boolean {
  const p = Object.fromEntries(new Intl.DateTimeFormat("en-US", { timeZone: "America/Denver", weekday: "short", hour: "2-digit", minute: "2-digit", hour12: false }).formatToParts(at).map((x) => [x.type, x.value]));
  if (p.weekday === "Sat" || p.weekday === "Sun") return false;
  const m = (Number(p.hour) % 24) * 60 + Number(p.minute);
  return (m >= 390 && m < 540) || (m >= 930 && m < 1110);
}
const padFor = (at?: Date) => (at && isRushHour(at) ? RUSH_PAD : TRAFFIC_PAD);

type Cache = { geo: Record<string, [number, number] | null>; miss?: Record<string, string>; route: Record<string, { s: number; m: number; at: string }> };

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

/**
 * Ways to ask for one address, most exact first. The free look-up often misses an address with a suite or unit
 * ("169 Inverness Dr W Ste 120") or a typo in the city, so it then tries without the unit, the street with just
 * the ZIP, and finally the city/ZIP alone (close enough for a drive time).
 */
export function addressVariants(address: string): string[] {
  const clean = address
    .replace(/\s+/g, " ")
    .replace(/[,\s]+(?:ste|suite|unit|apt|apartment|bldg|building|fl|floor|rm|room|spc|space|lot)\.?\s*#?\s*[\w-]+/gi, "")
    .replace(/\s*#\s*[\w-]+/g, "")
    .replace(/\b(usa|united states)\b/gi, "")
    .replace(/\s*,\s*,/g, ",")
    .replace(/[,\s]+$/, "")
    .trim();
  const parts = clean.split(",").map((x) => x.trim()).filter(Boolean);
  const zip = clean.match(/\b\d{5}\b(?!.*\b\d{5}\b)/)?.[0];
  const street = parts[0] ?? "";
  const tail = parts.slice(1).join(", ");
  const out = [address.trim(), clean, zip && street ? `${street}, ${zip}` : "", tail && /\d/.test(street) ? `${street}, ${tail.replace(/\b\d{5}(-\d{4})?\b/, "").trim()}` : "", tail || zip || ""];
  return [...new Set(out.map((x) => x.replace(/[,\s]+$/, "").trim()).filter((x) => x.length >= 5))];
}
const UA = "ForefrontHub/1.0 (personal work hub; light use)";

export class OsmTravel extends Cached implements TravelClient {
  readonly kind = "osm" as const;
  private lastGeo = 0;

  /** Nominatim allows one request a second; addresses are cached for good. */
  /** Nominatim allows one request a second. Found addresses are kept for good; misses are retried after a day. */
  async geocode(address: string): Promise<[number, number] | null> {
    const k = norm(address);
    const miss = this.cache.miss?.[k];
    if (this.cache.geo[k]) return this.cache.geo[k];
    if (miss && Date.now() - Date.parse(miss) < 86400_000) return null;
    for (const q of addressVariants(address)) {
      const hit = await this.search(q);
      if (hit) {
        this.cache.geo[k] = hit;
        if (this.cache.miss) delete this.cache.miss[k];
        this.save();
        return hit;
      }
    }
    (this.cache.miss ??= {})[k] = new Date().toISOString();
    this.save();
    return null;
  }

  private async search(q: string): Promise<[number, number] | null> {
    const wait = this.lastGeo + 1100 - Date.now();
    if (wait > 0) await new Promise((r) => setTimeout(r, wait));
    this.lastGeo = Date.now();
    const u = `https://nominatim.openstreetmap.org/search?${new URLSearchParams({ format: "json", limit: "1", countrycodes: "us", q })}`;
    const r = await fetch(u, { headers: { "User-Agent": UA, Accept: "application/json" } });
    if (!r.ok) throw new Error(`Address look-up failed (${r.status})`);
    const hit = ((await r.json()) as { lat: string; lon: string }[])[0];
    return hit ? [Number(hit.lon), Number(hit.lat)] : null;
  }

  /** Photon is built for search-as-you-type (Nominatim isn't, and asks not to be used that way). */
  async suggest(q: string): Promise<string[]> {
    const u = `https://photon.komoot.io/api/?${new URLSearchParams({ q, limit: "6", lang: "en", lat: "39.65", lon: "-104.95", bbox: "-109.1,36.9,-102.0,41.1" })}`;
    const r = await fetch(u, { headers: { "User-Agent": UA, Accept: "application/json" }, signal: AbortSignal.timeout(4000) });
    if (!r.ok) return [];
    const j = (await r.json()) as { features?: { properties?: Parameters<typeof placeLabel>[0] & { countrycode?: string } }[] };
    return [...new Set((j.features ?? []).filter((f) => !f.properties?.countrycode || f.properties.countrycode === "US").map((f) => placeLabel(f.properties ?? {})).filter((x) => x.length > 4))];
  }

  async drive(from: string, to: string, departAt?: Date): Promise<Drive | null> {
    const key = `${norm(from)}|${norm(to)}`;
    const hit = this.cache.route[key];
    const pad = padFor(departAt), rush = pad === RUSH_PAD;
    if (hit && Date.now() - Date.parse(hit.at) < 30 * 86400_000) return { minutes: Math.round((hit.s * pad) / 60), miles: hit.m, rush };
    const [a, b] = [await this.geocode(from), await this.geocode(to)];
    if (!a || !b) return null;
    const r = await fetch(`https://router.project-osrm.org/route/v1/driving/${a.join(",")};${b.join(",")}?overview=false`, { headers: { "User-Agent": UA } });
    if (!r.ok) throw new Error(`Route look-up failed (${r.status})`);
    const j = (await r.json()) as { code: string; routes?: { duration: number; distance: number }[] };
    const route = j.routes?.[0];
    if (j.code !== "Ok" || !route) return null;
    this.cache.route[key] = { s: route.duration, m: Math.round((route.distance / 1609.34) * 10) / 10, at: new Date().toISOString() };
    this.save();
    return { minutes: Math.round((route.duration * pad) / 60), miles: this.cache.route[key].m, rush };
  }
}

/** Fixed, made-up drive times for tests: 10 minutes plus one per character of difference in the street number. */
export class MockTravel implements TravelClient {
  readonly kind = "mock" as const;
  calls: { from: string; to: string }[] = [];
  async suggest(q: string): Promise<string[]> {
    return /nowhere/i.test(q) ? [] : [`${q.trim()} Example St, Denver, CO 80202`];
  }
  async drive(from: string, to: string): Promise<Drive | null> {
    this.calls.push({ from, to });
    if (/nowhere/i.test(to)) return null;
    const n = (s: string) => Number(s.match(/\d+/)?.[0] ?? 0);
    const minutes = 10 + (Math.abs(n(from) - n(to)) % 40);
    return { minutes, miles: Math.round(minutes * 0.6 * 10) / 10, rush: false };
  }
}

export function makeTravel(cfg: Config): TravelClient {
  if (cfg.mode === "mock") return new MockTravel();
  return new OsmTravel(cfg.stateDir);
}
