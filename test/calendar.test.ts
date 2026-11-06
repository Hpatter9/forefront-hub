import { mkdtempSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { freeSlots, MockCalendar } from "../src/connectors/calendar/index.js";
import { MockTasks } from "../src/connectors/tasks/index.js";

describe("calendar", () => {
  it("creates, moves and deletes events, and links job numbers", async () => {
    const cal = new MockCalendar(mkdtempSync(path.join(os.tmpdir(), "cal-")));
    const ev = await cal.create({ title: "Scope walk #3226 Augustine", start: "2026-11-10T16:00:00.000Z", end: "2026-11-10T17:00:00.000Z", location: "1071 Acapulco Ct" });
    expect(ev.jobNumber).toBe(3226);
    await cal.update(ev.calendarId, ev.id, { start: "2026-11-10T18:00:00.000Z", end: "2026-11-10T19:00:00.000Z" });
    const got = await cal.events({ start: "2026-11-10T00:00:00Z", end: "2026-11-11T00:00:00Z" });
    expect(got.map((e) => [e.title, e.start])).toEqual([["Scope walk #3226 Augustine", "2026-11-10T18:00:00.000Z"]]);
    await cal.remove(ev.calendarId, ev.id);
    expect(await cal.events({ start: "2026-11-10T00:00:00Z", end: "2026-11-11T00:00:00Z" })).toEqual([]);
  });

  it("finds open weekday time around busy blocks", () => {
    const from = new Date(2026, 10, 9, 6, 0); // Mon Nov 9, 6am local
    const busy = [{ start: new Date(2026, 10, 9, 9, 0).toISOString(), end: new Date(2026, 10, 9, 12, 0).toISOString() }];
    const slots = freeSlots(busy, { from, days: 1, minutes: 60 });
    expect(slots.map((s) => [new Date(s.start).getHours(), new Date(s.end).getHours()])).toEqual([[7, 9], [12, 17]]);
  });
});

describe("Google Tasks", () => {
  it("adds, checks off and reopens tasks", async () => {
    const t = new MockTasks(mkdtempSync(path.join(os.tmpdir(), "tasks-")));
    const k = await t.create({ title: "Call Eileen re #3226", due: "2026-11-09" });
    expect(k).toMatchObject({ jobNumber: 3226, due: "2026-11-09", completed: false });
    await t.update(k.listId, k.id, { completed: true });
    expect((await t.tasks()).some((x) => x.id === k.id)).toBe(false); // done ones hidden unless asked
    expect((await t.tasks({ showCompleted: true })).find((x) => x.id === k.id)?.completed).toBe(true);
    await t.update(k.listId, k.id, { completed: false, due: null });
    expect((await t.tasks()).find((x) => x.id === k.id)).toMatchObject({ completed: false, due: undefined });
  });
});
