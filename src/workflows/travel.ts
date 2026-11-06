import type { CalEvent } from "../connectors/calendar/index.js";
import type { Hub } from "../hub.js";

/**
 * Drive times for the day's appointments. Each timed event with a real address gets the drive from where you'll
 * be before it: the previous appointment that day with an address, or the day's start (the office, or
 * HUB_DAY_START_ADDRESS) for the first. "Leave by" keeps a few minutes spare to park and walk up.
 */
export interface Leg {
  eventId: string;
  from: string;
  fromLabel: string;
  minutes: number;
  miles: number;
  traffic: boolean;
  /** ISO time to leave. */
  leaveBy: string;
  /** Minutes you'd be late coming straight from the previous appointment (only when it's tight). */
  late?: number;
  mapsUrl: string;
}

export const SPARE_MINUTES = 5;
const VIRTUAL = /(zoom\.us|meet\.google|teams\.microsoft|webex|https?:\/\/|^\s*(phone|call|online|virtual|tbd|office)\s*$)/i;

/** An event location worth routing to: a street address or a named place, not a video link or "Phone". */
export function routable(location?: string): boolean {
  const l = (location ?? "").trim();
  return l.length >= 6 && !VIRTUAL.test(l) && /\d|,/.test(l);
}

const denverDay = (iso: string) => new Date(iso).toLocaleDateString("en-CA", { timeZone: "America/Denver" });

export async function travelFor(hub: Hub, events: CalEvent[], o: { max?: number } = {}): Promise<Record<string, Leg>> {
  const start = hub.cfg.travel.start;
  const timed = events.filter((e) => !e.allDay && routable(e.location)).sort((a, b) => a.start.localeCompare(b.start));
  const out: Record<string, Leg> = {};
  let looked = 0;
  for (const e of timed) {
    if (looked >= (o.max ?? 30)) break;
    const prev = [...timed].reverse().find((p) => p !== e && p.start < e.start && denverDay(p.start) === denverDay(e.start) && p.end <= e.start && p.location !== e.location);
    const from = prev?.location ?? start;
    if (!from || from === e.location) continue;
    looked++;
    const begins = new Date(e.start);
    const d = await hub.travel.drive(from, e.location!, new Date(begins.getTime() - 40 * 60_000)).catch(() => null);
    if (!d) continue;
    const leave = new Date(begins.getTime() - (d.minutes + SPARE_MINUTES) * 60_000);
    const leg: Leg = {
      eventId: e.id,
      from,
      fromLabel: prev ? prev.title : "the office",
      minutes: d.minutes,
      miles: d.miles,
      traffic: d.traffic,
      leaveBy: leave.toISOString(),
      mapsUrl: `https://www.google.com/maps/dir/?${new URLSearchParams({ api: "1", origin: from, destination: e.location!, travelmode: "driving" })}`,
    };
    if (prev) {
      const free = (begins.getTime() - new Date(prev.end).getTime()) / 60_000;
      if (free < d.minutes) leg.late = Math.round(d.minutes - free);
    }
    out[e.id] = leg;
  }
  return out;
}
