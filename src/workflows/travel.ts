import type { CalEvent } from "../connectors/calendar/index.js";
import type { Hub } from "../hub.js";

/** "Leave by" keeps a few minutes spare to park and walk up. */
export interface Leg {
  eventId: string;
  jobNumber: number;
  from: string;
  /** The address driven to (the event's location, or the job's address when the event has none). */
  to: string;
  fromLabel: string;
  minutes: number;
  miles: number;
  /** Padded for rush hour. */
  rush: boolean;
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

const street = (a: string) => (a || "").split(",")[0].toLowerCase().replace(/\b(street|st|avenue|ave|drive|dr|court|ct|road|rd|lane|ln|way|boulevard|blvd|circle|cir|place|pl|parkway|pkwy|trail|trl|terrace|ter)\b\.?/g, "").replace(/[^a-z0-9]/g, "");

/**
 * Drive times for your job visits only. A calendar event is a job visit when it names a job (#3226) or its address
 * is a job's address; a visit with no location set uses the job's address. Visits chain through the day: from
 * the office (or HUB_DAY_START_ADDRESS) to the first job, then straight from each job to the next. Other events
 * (meetings, lunch, video calls) get no drive time and don't break the chain. `calendars`: only events on these
 * calendars count (your own calendar, not shared team ones).
 */
export async function travelFor(hub: Hub, events: CalEvent[], o: { max?: number; calendars?: Set<string> } = {}): Promise<Record<string, Leg>> {
  const jobs = hub.jobs.list();
  const byStreet = new Map(jobs.filter((j) => street(j.address).length >= 5).map((j) => [street(j.address), j]));
  const visits = events
    .filter((e) => !e.allDay && (!o.calendars || o.calendars.has(e.calendarId)))
    .map((e) => {
      const job = (e.jobNumber && jobs.find((j) => j.jobNumber === e.jobNumber)) || (routable(e.location) ? byStreet.get(street(e.location!)) : undefined);
      if (!job) return null;
      const place = routable(e.location) ? e.location! : job.address;
      return routable(place) ? { e, job, place } : null;
    })
    .filter((v): v is NonNullable<typeof v> => !!v)
    .sort((a, b) => a.e.start.localeCompare(b.e.start));

  const out: Record<string, Leg> = {};
  let looked = 0;
  for (let i = 0; i < visits.length && looked < (o.max ?? 30); i++) {
    const { e, place } = visits[i];
    const prev = i > 0 && denverDay(visits[i - 1].e.start) === denverDay(e.start) ? visits[i - 1] : null;
    const from = prev?.place ?? hub.cfg.travel.start;
    if (!from || street(from) === street(place)) continue; // same house: no drive
    looked++;
    const begins = new Date(e.start);
    const d = await hub.travel.drive(from, place, new Date(begins.getTime() - 40 * 60_000)).catch(() => null);
    if (!d) continue;
    const leave = new Date(begins.getTime() - (d.minutes + SPARE_MINUTES) * 60_000);
    const leg: Leg = {
      eventId: e.id,
      jobNumber: visits[i].job.jobNumber,
      from,
      to: place,
      fromLabel: prev ? `#${prev.job.jobNumber} ${prev.job.name}`.trim() : "the office",
      minutes: d.minutes,
      miles: d.miles,
      rush: d.rush,
      leaveBy: leave.toISOString(),
      mapsUrl: `https://www.google.com/maps/dir/?${new URLSearchParams({ api: "1", origin: from, destination: place, travelmode: "driving" })}`,
    };
    if (prev) {
      const free = (begins.getTime() - new Date(prev.e.end).getTime()) / 60_000;
      if (free < d.minutes + SPARE_MINUTES) leg.late = Math.max(1, Math.round(d.minutes + SPARE_MINUTES - free));
    }
    out[e.id] = leg;
  }
  return out;
}
