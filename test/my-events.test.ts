import { describe, expect, it } from "vitest";
import type { CalEvent } from "../src/connectors/calendar/index.js";
import { myEvents } from "../src/workflows/myEvents.js";
import { testHub } from "./helpers.js";

const ev = (id: string, calendarId: string, myResponse?: string, start = "2026-11-10T15:00:00Z"): CalEvent => ({ id, calendarId, title: id, start, end: start, allDay: false, myResponse });

describe("my schedule", () => {
  it("keeps my calendar and invitations, drops other people's meetings and what I declined", async () => {
    const { hub } = testHub();
    hub.calendar = {
      ...hub.calendar,
      calendars: async () => [{ id: "hunter@forefrontteam.com", name: "Hunter", color: "", primary: true, writable: true }, { id: "eric@forefrontteam.com", name: "Eric", color: "", primary: false, writable: false }],
      events: async () => [
        ev("My scope walk", "hunter@forefrontteam.com"),
        ev("Eric's walkthrough", "eric@forefrontteam.com"),
        ev("Eric's meeting I'm invited to", "eric@forefrontteam.com", "accepted", "2026-11-10T16:00:00Z"),
        ev("Team lunch I declined", "eric@forefrontteam.com", "declined"),
        ev("Recon wrap-up", "hunter@forefrontteam.com", "needsAction", "2026-11-10T17:00:00Z"),
        ev("Recon wrap-up", "eric@forefrontteam.com", "needsAction", "2026-11-10T17:00:00Z"),
      ],
    } as any;
    const mine = await myEvents(hub, { start: "2026-11-10T00:00:00Z", end: "2026-11-11T00:00:00Z" });
    expect(mine.map((e) => e.title)).toEqual(["My scope walk", "Eric's meeting I'm invited to", "Recon wrap-up"]);
  });
});
