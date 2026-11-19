import { describe, expect, it } from "vitest";
import { shorten, summariesFor, withJob } from "../src/agent/mailSummary.js";
import { allSigns, jobOfMail } from "../src/workflows/jobMail.js";
import { testHub } from "./helpers.js";

describe("one-line email summaries", () => {
  it("keeps a summary to one line of 10 words or fewer", () => {
    expect(shorten('"Adjuster wants hallway flooring photos showing cupping before approving the LVP."')).toBe("Adjuster wants hallway flooring photos showing cupping before approving the");
    expect(shorten("  Sent\nWegener the revised estimate. ")).toBe("Sent Wegener the revised estimate");
  });
  it("has nothing for threads it hasn't summarized", () => {
    const { hub } = testHub();
    expect(summariesFor(hub, [{ id: "t1", historyId: "5" }])).toEqual({});
  });
  it("starts the line with the job's name, without saying it twice", () => {
    expect(withJob("Gorrell", "Adjuster wants hallway photos")).toBe("Gorrell - Adjuster wants hallway photos");
    expect(withJob("Gorrell", "Gorrell: checking in on estimate review")).toBe("Gorrell - checking in on estimate review");
    expect(withJob("", "Vendor newsletter")).toBe("Vendor newsletter");
  });
  it("works out which job a conversation is about from the job's own signs, or leaves it off", () => {
    const { hub } = testHub();
    hub.jobs.upsert(3212, { name: "Gorrell", address: "9842 Awaken Drive, Colorado Springs, CO 80924", claimNumber: "06-0S9L-844", customer: { name: "Roland Gorrell", email: "roland@example.com", phone: "", company: "", attention: "" } });
    hub.jobs.upsert(3234, { name: "Williams", address: "55 Oak St, Denver, CO 80211", claimNumber: "062336200", customer: { name: "Pat Williams", email: "pat@example.com", phone: "", company: "", attention: "" } });
    const all = allSigns(hub, true);
    expect(jobOfMail(all, "Subject: 06-0S9L-844\nChecking in on the estimate", ["adjuster@carrier.example"])).toBe(3212);
    expect(jobOfMail(all, "Following up", ["me@forefrontteam.com", "office+3234@forefrontteam.com"])).toBe(3234);
    expect(jobOfMail(all, "Quick question about the schedule", ["pat@example.com"])).toBe(3234);
    expect(jobOfMail(all, "Lunch on Friday?", ["friend@example.com"])).toBeNull();
    expect(jobOfMail(all, "Claims 06-0S9L-844 and 062336200 both need photos", ["adjuster@carrier.example"])).toBeNull();
  });
  it("re-does summaries saved before job names were added", async () => {
    const { hub } = testHub();
    const { writeFileSync, mkdirSync } = await import("node:fs");
    mkdirSync(hub.cfg.stateDir, { recursive: true });
    writeFileSync(`${hub.cfg.stateDir}/mail-summaries.json`, JSON.stringify({ old: { h: "1", s: "Old style line" }, fresh: { h: "1", s: "Adjuster wants photos", j: "Gorrell" }, none: { h: "1", s: "Vendor newsletter", j: "" } }));
    expect(summariesFor(hub, [{ id: "old", historyId: "1" }, { id: "fresh", historyId: "1" }, { id: "none", historyId: "1" }])).toEqual({ fresh: "Gorrell - Adjuster wants photos", none: "Vendor newsletter" });
  });
});
