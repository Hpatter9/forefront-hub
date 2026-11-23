import type { Hub } from "../hub.js";

/**
 * What the Location box on a calendar event offers as you type: your jobs' addresses first, then places you've put
 * on events before, then addresses from the map. Picking one fills the box in.
 */
export interface Place { label: string; sub: string; kind: "job" | "past" | "map" }

let past: { at: number; list: string[] } | null = null;
/** Locations on your events from the last four months and the next two (read at most every ten minutes). */
async function pastLocations(hub: Hub): Promise<string[]> {
  if (past && Date.now() - past.at < 10 * 60_000) return past.list;
  const day = 86_400_000;
  const events = hub.calendar.connected() ? await hub.calendar.events({ start: new Date(Date.now() - 120 * day).toISOString(), end: new Date(Date.now() + 60 * day).toISOString() }).catch(() => []) : [];
  const count = new Map<string, number>();
  for (const e of events) { const l = (e.location ?? "").trim(); if (l.length > 3) count.set(l, (count.get(l) ?? 0) + 1); }
  past = { at: Date.now(), list: [...count].sort((a, b) => b[1] - a[1]).map(([l]) => l) };
  return past.list;
}
export const forgetPastLocations = () => { past = null; };

export async function suggestPlaces(hub: Hub, q: string, opts: { online?: boolean } = {}): Promise<Place[]> {
  const words = q.toLowerCase().split(/\s+/).filter(Boolean);
  if (!words.length || q.trim().length < 2) return [];
  const hit = (text: string) => words.every((w) => text.toLowerCase().includes(w));
  const out: Place[] = [];
  const seen = new Set<string>();
  const add = (p: Place) => { const k = p.label.toLowerCase().replace(/[^a-z0-9]/g, ""); if (k && !seen.has(k)) { seen.add(k); out.push(p); } };
  for (const j of hub.jobs.list()) if (j.address && hit(`${j.address} ${j.name} ${j.jobNumber} ${j.customer.name}`)) add({ label: j.address, sub: `#${j.jobNumber} ${j.name}`, kind: "job" });
  for (const l of await pastLocations(hub)) if (hit(l)) add({ label: l, sub: "Used on your calendar before", kind: "past" });
  // The map is only asked once there's enough typed to mean something, and only when your own places don't cover it.
  if (opts.online !== false && q.trim().length >= 4 && out.length < 5 && hub.travel.suggest) {
    for (const l of await hub.travel.suggest(q.trim()).catch(() => [])) add({ label: l, sub: "From the map", kind: "map" });
  }
  return out.slice(0, 8);
}
