import { describe, expect, it } from "vitest";
import { homebaseFixes, reminders } from "../src/workflows/reminders.js";
import { pullJob } from "../src/workflows/pull.js";
import { testHub } from "./helpers.js";

describe("Fix in Homebase", () => {
  it("flags a missing adjuster, one Keystone only found in emails, a proposal sent at the wrong stage, and a signed agreement", async () => {
    const { hub } = testHub();
    await pullJob(hub, 9001);
    hub.jobs.upsert(9001, { stage: "Estimating", insurance: "claim", carrier: "State Farm", claimNumber: "06-X", adjuster: { name: "", email: "", phone: "" } });
    let f = homebaseFixes(hub.jobs.get(9001));
    expect(f.map((x) => x.title)).toEqual(["Adjuster email missing"]);
    hub.jobs.upsert(9001, { adjuster: { name: "Raj", email: "raj@sf.example", phone: "" }, pulse: { adjusterGuess: { name: "Raj", email: "raj@sf.example", why: "wrote about the claim" } } });
    hub.jobs.upsert(9001, { sendoff: { ...hub.jobs.get(9001).sendoff, sentAt: "2026-11-10T16:00:00Z" } });
    f = homebaseFixes(hub.jobs.get(9001));
    expect(f.map((x) => [x.title, x.toStage])).toEqual([["Adjuster isn't in Homebase", undefined], ["Stage says Estimating, but the proposal went out", "Proposal Submitted"]]);
    hub.jobs.upsert(9001, { stage: "Proposal Submitted" });
    hub.jobs.log(9001, 'Draft (handoff) "Project Handoff" to sam@example.com: agreement signed 2026-11-20');
    f = homebaseFixes(hub.jobs.get(9001));
    expect(f.at(-1)).toMatchObject({ title: "Agreement signed, stage still Proposal Submitted", toStage: "Job Won" });
    expect(reminders(hub).filter((r) => r.kind === "fix" && r.jobNumber === 9001).length).toBe(f.length);
  });

  it("says nothing about a job where Homebase is right", async () => {
    const { hub } = testHub();
    await pullJob(hub, 9001);
    hub.jobs.upsert(9001, { stage: "Estimating", insurance: "oop", carrier: "", claimNumber: "" });
    expect(homebaseFixes(hub.jobs.get(9001))).toEqual([]);
  });
});
