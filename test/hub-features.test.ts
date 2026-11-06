import { describe, expect, it } from "vitest";
import { confirmText } from "../src/core/approval.js";
import { editFields, fieldValues, readField, setAdjuster } from "../src/workflows/fields.js";
import { pullJob } from "../src/workflows/pull.js";
import { reminders } from "../src/workflows/reminders.js";
import { timeline } from "../src/workflows/timeline.js";
import { testHub } from "./helpers.js";

describe("editing Homebase fields", () => {
  it("shows old -> new, saves after a yes, and logs it", async () => {
    const { hub, homebase, approver } = testHub(true);
    await pullJob(hub, 9001);
    const r = await editFields(hub, 9001, { claimNumber: "EX-999", lockboxCode: "4417" });
    expect(r).toEqual({ claimNumber: { ok: true, changed: true }, lockboxCode: { ok: true, changed: true } });
    expect(approver.asked.at(-1)!.details).toEqual(["Claim number: EX-12345 → EX-999", "Lockbox code: (blank) → 4417"]);
    expect(homebase.writes.at(-1)).toMatchObject({ op: "updateFields", args: { claimNumber: "EX-999", lockboxCode: "4417" } });
    expect(fieldValues(await homebase.rawJob(9001))).toMatchObject({ claimNumber: "EX-999", lockboxCode: "4417" });
  });

  it("warns that a proposal amount restamps the date, and writes nothing on a no", async () => {
    const { hub, homebase, approver } = testHub(false);
    await pullJob(hub, 9001);
    expect(await editFields(hub, 9001, { proposalAmount: "12000" })).toBeNull();
    expect(approver.asked[0].details.join(" ")).toMatch(/proposal submitted date to today/);
    expect(homebase.writes).toEqual([]);
  });

  it("adds an adjuster as a Homebase contact and puts them on the job", async () => {
    const { hub, homebase } = testHub(true);
    await pullJob(hub, 9001);
    await setAdjuster(hub, 9001, 1, { first: "Eileen", last: "Brandt", email: "eileen@claims.example" });
    expect(homebase.writes.map((w) => w.op)).toEqual(["createContact", "updateFields"]);
    expect(homebase.writes[1].args).toEqual({ adjuster1: "contact-eileen-brandt" });
    expect(hub.jobs.get(9001).adjuster).toMatchObject({ name: "Eileen Brandt", email: "eileen@claims.example" });
  });

  it("reads a field wherever the job read keeps it", () => {
    expect(readField({ brief: { claimNumber: "A1" }, money: { proposalAmount: 5 }, platform: { access: { gateCode: "9" } } }, "gateCode")).toBe("9");
    expect(readField({ money: { proposalAmount: 5 } }, "proposalAmount")).toBe(5);
  });
});

describe("Today reminders", () => {
  it("flags a reply waiting, an estimate needed and a quiet proposal", async () => {
    const { hub } = testHub(true);
    await pullJob(hub, 9001); // Estimating, no proposal
    await pullJob(hub, 9002); // Proposal Submitted since 2026-10-20
    const old = new Date(Date.now() - 9 * 864e5).toISOString();
    hub.jobs.upsert(9001, { pulse: { lastTouchAt: old, lastTouch: "note", waiting: { from: "Alex Adjuster", subject: "Need more photos", at: old, threadId: "t1" }, proposalAmount: null, checkedAt: old } });
    hub.jobs.upsert(9002, { pulse: { lastTouchAt: old, lastTouch: "emailed sam@example.com", waiting: null, proposalAmount: 8450.12, checkedAt: old } });
    const r = reminders(hub);
    expect(r.find((x) => x.kind === "reply")).toMatchObject({ jobNumber: 9001, title: "Need more photos", threadId: "t1", days: 9 });
    expect(r.find((x) => x.kind === "estimate")).toMatchObject({ jobNumber: 9001 });
    expect(r.find((x) => x.kind === "followup")).toMatchObject({ jobNumber: 9002, title: "$8,450.12 proposal" });
    expect(r.some((x) => x.kind === "stale" && x.jobNumber === 9001)).toBe(false); // waiting on a reply beats "stale"
  });
});

describe("timeline", () => {
  it("merges Homebase notes and hub drafts, newest first", async () => {
    const { hub } = testHub(true);
    await pullJob(hub, 9001);
    hub.jobs.upsert(9001, { sendoff: { drafts: [{ id: "d1", kind: "homeowner", to: ["jane.sample@example.com"], subject: "Your Reconstruction Estimate – 123 Main St", messageId: "<x>", attachments: [], createdAt: "2026-11-05T10:00:00Z" }] } });
    const t = await timeline(hub, 9001);
    expect(t.map((i) => [i.kind, i.source])).toEqual([["draft", "hub"], ["note", "homebase-note"]]);
  });
});

describe("editable approvals", () => {
  it("returns the edited text, or null for no", async () => {
    const yes = { confirm: async () => true, confirmText: async (_a: string, _d: string[], t: string) => `${t} (edited)` };
    expect(await confirmText(yes, "Add?", [], "Called Eileen")).toBe("Called Eileen (edited)");
    expect(await confirmText({ confirm: async () => false }, "Add?", [], "x")).toBeNull();
  });
});
