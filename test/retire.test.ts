import { describe, expect, it } from "vitest";
import { retired } from "../src/core/job.js";
import { syncAll } from "../src/workflows/background.js";
import { pullJob } from "../src/workflows/pull.js";
import { reminders } from "../src/workflows/reminders.js";
import { testHub } from "./helpers.js";

describe("jobs closed more than 30 days drop out", () => {
  it("stamps a job Homebase no longer lists as open, and retires it 30 days later", async () => {
    const { hub } = testHub();
    await pullJob(hub, 9001);
    const open = await hub.homebase.listJobs({ openOnly: true });
    // Homebase stops listing 9001 as open.
    hub.homebase.listJobs = async () => open.filter((j) => j.jobNumber !== 9001);
    await syncAll(hub);
    const stamped = hub.jobs.get(9001).closedSince;
    expect(stamped).not.toBe("");
    expect(hub.jobs.active().map((j) => j.jobNumber)).toContain(9001); // still shown for 30 days
    hub.jobs.upsert(9001, { closedSince: new Date(Date.now() - 31 * 864e5).toISOString(), stage: "Estimating" });
    expect(retired(hub.jobs.get(9001))).toBe(true);
    expect(hub.jobs.active().map((j) => j.jobNumber)).not.toContain(9001);
    expect(reminders(hub).some((r) => r.jobNumber === 9001)).toBe(false);
    const r = await syncAll(hub);
    expect(r.errors).toEqual([]);
    expect(hub.jobs.exists(9001)).toBe(true); // the folder stays
  });

  it("brings a job back the moment Homebase lists it as open again", async () => {
    const { hub } = testHub();
    await pullJob(hub, 9001);
    hub.jobs.upsert(9001, { closedSince: new Date(Date.now() - 40 * 864e5).toISOString() });
    await syncAll(hub);
    expect(hub.jobs.get(9001).closedSince).toBe("");
    expect(hub.jobs.active().map((j) => j.jobNumber)).toContain(9001);
  });
});
