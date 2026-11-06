import { describe, expect, it } from "vitest";
import { briefDue } from "../src/workflows/brief.js";

const o = { at: "07:00", days: "1-5", until: "17:00" };
// Friday 2026-11-06 in Denver (MST, UTC-7).
const fri = (hm: string) => new Date(`2026-11-06T${hm}:00-07:00`);

describe("morning brief schedule", () => {
  it("runs at 7 on a weekday, once", () => {
    expect(briefDue(fri("06:59"), null, o)).toBe(false);
    expect(briefDue(fri("07:00"), null, o)).toBe(true);
    expect(briefDue(fri("07:01"), { startedAt: fri("07:00").toISOString() }, o)).toBe(false);
  });
  it("catches up when the hub opens later, but not after 5 PM", () => {
    expect(briefDue(fri("09:40"), { startedAt: new Date("2026-11-05T14:00:00Z").toISOString() }, o)).toBe(true);
    expect(briefDue(fri("17:05"), null, o)).toBe(false);
  });
  it("skips weekends unless asked, and can be switched off", () => {
    const sat = new Date("2026-11-07T08:00:00-07:00");
    expect(briefDue(sat, null, o)).toBe(false);
    expect(briefDue(sat, null, { ...o, days: "0-6" })).toBe(true);
    expect(briefDue(fri("08:00"), null, { ...o, at: "off" })).toBe(false);
  });
});
