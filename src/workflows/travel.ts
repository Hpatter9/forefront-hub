import type { CalEvent } from "../connectors/calendar/index.js";
import type { Job } from "../core/job.js";
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
/** "1071 Acapulco Ct" -> "1071 acapulco": the house number and the first word of the street. */
const houseKey = (a: string) => {
  const m = (a || "").toLowerCase().match(/^\s*(\d+)\s+(?:[nsew]\.?\s+)?([a-z0-9]+)/);
  return m ? `${m[1]} ${m[2]}` : "";
};

/** The job a calendar event is a visit to: by #job number, by address, or by the job's name in the title. */
export function jobForEvent(e: CalEvent, jobs: Job[]): Job | undefined {
  if (e.jobNumber) {
    const j = jobs.find((x) => x.jobNumber === e.jobNumber);
    if (j) return j;
  }
  if (e.location) {
    const hit = jobs.filter((j) => j.address && (street(j.address) === street(e.location!) || (houseKey(j.address) && houseKey(j.address) === houseKey(e.location!))));
    if (hit.length === 1) return hit[0];
  }
  const text = `${e.title} ${e.description ?? ""}`.toLowerCase();
  const byName = jobs.filter((j) => j.name.length >= 4 && new RegExp(`\\b${j.name.toLowerCase().replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`).test(text));
  return byName.length === 1 ? byName[0] : undefined;
}

export async function travelFor(hub: Hub, events: CalEvent[], o: { max?: number; calendars?: Set<string>; why?: Record<string, string> } = {}): Promise<Record<string, Leg>> {
  const jobs = hub.jobs.list();
  const why = o.why ?? {};
  const visits = events
    .filter((e) => !e.allDay)
    .map((e) => {
      if (o.calendars && !o.calendars.has(e.calendarId)) {
        why[e.id] = "This event is on a shared calendar, not yours, so it gets no drive time.";
        return null;
      }
      const job = jobForEvent(e, jobs);
      if (!job) {
        why[e.id] = "Keystone can't tell which job this is. Put the job number in the title (e.g. #3226) or use the job's address as the location.";
        return null;
      }
      const place = routable(e.location) ? e.location! : job.address;
      if (!routable(place)) {
        why[e.id] = `No address for #${job.jobNumber} yet. Add the location to the event.`;
        return null;
      }
      return { e, job, place };
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
    let failed = "";
    const d = await hub.travel.drive(from, place, new Date(begins.getTime() - 40 * 60_000)).catch((err: Error) => {
      failed = /fetch failed|ENOTFOUND|ECONN|network/i.test(err.message) ? "The map service didn't answer (no internet?). It will try again." : err.message;
      return null;
    });
    if (!d) {
      why[e.id] = failed || `The map couldn't find "${place}"${prev ? "" : ` or the office ("${from}")`}. Check the address on the event.`;
      continue;
    }
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
