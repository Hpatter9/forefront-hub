import { describe, expect, it } from "vitest";
import { checkEmailButtons } from "../src/workflows/briefEmails.js";
import { addressedToMe, briefItems, type Reminder } from "../src/workflows/reminders.js";
import { testHub } from "./helpers.js";

const r = (o: Partial<Reminder>): Reminder => ({ kind: "reply", jobNumber: 1, name: "X", stage: "Estimating", title: "", detail: "", days: 1, ...o });

describe("what goes in the brief", () => {
  it("keeps only recent items", () => {
    const { items, left } = briefItems([r({ kind: "reply", days: 3 }), r({ kind: "reply", days: 40 }), r({ kind: "followup", stage: "Proposal Submitted", days: 10 }), r({ kind: "followup", stage: "Proposal Submitted", days: 200 })]);
    expect(items.map((x) => x.days)).toEqual([3, 10]);
    expect(left.map((x) => x.days)).toEqual([40, 200]);
  });

  it("leaves out quiet jobs in someone else's stage (production), but keeps emails written to me", () => {
    const { items } = briefItems([r({ kind: "stale", stage: "Job Won", days: 9 }), r({ kind: "stale", stage: "Estimating", days: 9 }), r({ kind: "reply", stage: "Job Won", days: 2 })]);
    expect(items.map((x) => `${x.kind}:${x.stage}`)).toEqual(["stale:Estimating", "reply:Job Won"]);
  });

  it("counts an email as waiting on me only when I'm on the To line", () => {
    expect(addressedToMe({ to: "Hunter <hunter@forefrontteam.com>", cc: "" }, "hunter@forefrontteam.com")).toBe(true);
    expect(addressedToMe({ to: "shannon@forefrontteam.com", cc: "hunter@forefrontteam.com" }, "hunter@forefrontteam.com")).toBe(false);
    expect(addressedToMe({ to: "office+3226@forefrontteam.com" }, "hunter@forefrontteam.com")).toBe(false);
  });
});

describe("View email buttons in the brief", () => {
  const setup = () => {
    const { hub } = testHub();
    hub.jobs.upsert(9001, { name: "Sample", address: "123 Main St, Denver, CO 80211", adjuster: { name: "Alex Adjuster", email: "alex.adjuster@carrier.example", phone: "" } });
    hub.jobs.upsert(9002, { name: "Example", address: "45 Pine Ave, Boulder, CO 80302", customer: { name: "Sam Example", email: "sam@example.com", phone: "" } });
    return hub;
  };

  it("keeps a button that opens an email about that job", async () => {
    const out = await checkEmailButtons(setup(), "1. #9001 Sample: answer Alex about the photos {email:mock-thread-1} {go:9001:job}");
    expect(out.text).toContain("{email:mock-thread-1}");
    expect(out.fixed + out.dropped).toBe(0);
  });

  it("swaps a button pointing at another job's email for this job's waiting email", async () => {
    const hub = setup();
    const j = hub.jobs.get(9002);
    hub.jobs.upsert(9002, { pulse: { ...j.pulse, waiting: { from: "Sam", subject: "Your Reconstruction Estimate – 45 Pine Ave", at: new Date().toISOString(), threadId: "mock-thread-2" } } });
    const out = await checkEmailButtons(hub, "2. #9002 Example: reply to Sam {email:mock-thread-1} {go:9002:job}");
    expect(out.text).toBe("2. #9002 Example: reply to Sam {email:mock-thread-2} {go:9002:job}");
    expect(out.fixed).toBe(1);
  });

  it("drops a button that matches nothing, or an email that doesn't exist", async () => {
    const out = await checkEmailButtons(setup(), "3. #9002 Example: follow up {email:mock-thread-3} {go:9002:job}\n4. Vendor invoice {email:not-a-thread-123}");
    expect(out.text).toBe("3. #9002 Example: follow up {go:9002:job}\n4. Vendor invoice");
    expect(out.dropped).toBe(2);
  });
});
