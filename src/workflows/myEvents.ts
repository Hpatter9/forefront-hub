import type { CalEvent } from "../connectors/calendar/index.js";
import type { Hub } from "../hub.js";

/**
 * Hunter's own schedule: events on his own calendar, plus events on anyone else's calendar (a teammate's, the
 * team calendar) that he's invited to, minus anything he declined. Other people's meetings he isn't on (Eric's
 * walkthroughs, the office's appointments) are left out. Used for everything that tells Hunter what HE is doing:
 * Ask, the daily brief and the dashboard's Today card.
 */
export async function myCalendarIds(hub: Hub): Promise<Set<string>> {
  const cals = await hub.calendar.calendars().catch(() => []);
  return new Set(["primary", hub.cfg.gmail.address.toLowerCase(), ...cals.filter((c) => c.primary).map((c) => c.id)]);
}

export function isMine(e: CalEvent, mine: Set<string>): boolean {
  if (e.myResponse === "declined") return false;
  return mine.has(e.calendarId) || e.myResponse !== undefined; // he's on its guest list
}

export async function myEvents(hub: Hub, o: { start: string; end: string; q?: string }): Promise<CalEvent[]> {
  const [mine, events] = await Promise.all([myCalendarIds(hub), hub.calendar.events(o)]);
  // The same meeting can show up on his calendar and on the shared one: keep one copy.
  const seen = new Set<string>();
  return events
    .filter((e) => isMine(e, mine))
    .sort((a, b) => Number(mine.has(b.calendarId)) - Number(mine.has(a.calendarId)))
    .filter((e) => {
      const k = `${e.title}|${e.start}`;
      if (seen.has(k)) return false;
      seen.add(k);
      return true;
    })
    .sort((a, b) => a.start.localeCompare(b.start));
}
