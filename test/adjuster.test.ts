import { describe, expect, it } from "vitest";
import { reminders } from "../src/workflows/reminders.js";
import { testHub } from "./helpers.js";

const ago = (d: number) => new Date(Date.now() - d * 864e5).toISOString();

describe("adjuster check-in reminder", () => {
  const setup = (o: { touch?: number; stage?: string; insurance?: "claim" | "oop"; waiting?: boolean }) => {
    const { hub } = testHub();
    hub.jobs.upsert(3184, {
      name: "Wegener",
      stage: o.stage ?? "Proposal Submitted",
      stageSince: ago(20),
      insurance: o.insurance ?? "claim",
      adjuster: { name: "Andrew Shakespeare", email: "andrew@statefarm.example", phone: "" },
      pulse: { lastTouchAt: ago(o.touch ?? 8), lastTouch: "email", checkedAt: ago(0), adjusterTouchAt: o.touch === undefined ? "" : ago(o.touch), adjusterTouch: "you emailed: Wegener estimate", waiting: o.waiting ? { from: "Andrew", subject: "Q", at: ago(1), threadId: "" } : null },
    });
    return reminders(hub).filter((r) => r.jobNumber === 3184).map((r) => r.kind);
  };
  it("shows once it's been a week since you were in touch with the adjuster", () => {
    expect(setup({ touch: 8 })).toEqual(["adjuster"]);
  });
  it("waits until a week has gone by", () => {
    expect(setup({ touch: 3 })).not.toContain("adjuster");
  });
  it("counts from the stage date when there's no contact on record", () => {
    expect(setup({})).toContain("adjuster");
  });
  it("leaves out-of-pocket jobs and jobs past the adjuster alone, and a waiting reply comes first", () => {
    expect(setup({ touch: 10, insurance: "oop" })).not.toContain("adjuster");
    expect(setup({ touch: 10, stage: "Work In Progress" })).not.toContain("adjuster");
    expect(setup({ touch: 10, waiting: true })).toEqual(["reply"]);
  });
});

describe("working out the adjuster from the job's emails", () => {
  it("picks whoever writes about the claim from a company address, not the homeowner or a designer", async () => {
    const { guessAdjuster } = await import("../src/workflows/reminders.js");
    const { testHub } = await import("./helpers.js");
    const { hub } = testHub();
    const j = hub.jobs.upsert(3232, { name: "Brickell", carrier: "Auto Owners", claimNumber: "300-0123456-2026", customer: { name: "Pat Brickell", email: "pat@gmail.com", phone: "" } });
    const people = [
      { addr: "Pat Brickell <pat@gmail.com>", name: "", text: "Re: claim 300-0123456-2026", at: "" },
      { addr: "Designer <alyssa@studio.example>", name: "", text: "paint colors", at: "" },
      { addr: "Designer <alyssa@studio.example>", name: "", text: "tile", at: "" },
      { addr: "Designer <alyssa@studio.example>", name: "", text: "more tile", at: "" },
      { addr: "Reseigh, Anngelica <areseigh@aoins.com>", name: "", text: "Claim 3000123456 2026 estimate review", at: "" },
    ];
    expect(guessAdjuster(j, people, "hunter@forefrontteam.com")).toMatchObject({ email: "areseigh@aoins.com", why: "writes about the claim number" });
    expect(guessAdjuster(j, people.slice(0, 4), "hunter@forefrontteam.com")).toBeNull();
  });
});
