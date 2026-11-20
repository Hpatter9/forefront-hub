import { mkdtempSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { checkProposalsSent, isProposalFile, typedAmount } from "../src/workflows/proposalSent.js";
import { pullJob } from "../src/workflows/pull.js";
import { testHub } from "./helpers.js";

const pdf = (name: string) => { const f = path.join(mkdtempSync(path.join(os.tmpdir(), "prop-")), name); writeFileSync(f, "pdf"); return f; };

/** An email with this attachment, made and sent outside the send-off (the compose box, Gmail itself). */
async function sendEstimate(hub: any, gmail: any, o: { to?: string[]; bcc?: string[]; file?: string; at?: string } = {}) {
  const ref = await hub.gmail.createDraft({ to: o.to ?? ["sam@example.com"], bcc: o.bcc ?? ["office+9001@forefrontteam.com"], subject: "Your estimate", body: "Attached.", attachments: [pdf(o.file ?? "Sample - Reconstruction Estimate.pdf")] });
  gmail.markSent(ref.id, o.at ?? "2026-11-06T16:00:00Z");
  return ref;
}

describe("an estimate sent any way moves the job to Proposal Submitted", () => {
  it("asks once, then writes the amount and date together and moves the stage", async () => {
    const { hub, gmail, homebase, approver } = testHub();
    await pullJob(hub, 9001);
    hub.jobs.upsert(9001, { estimate: { ...hub.jobs.get(9001).estimate, total: 7188.14 } });
    await sendEstimate(hub, gmail);
    const r = await checkProposalsSent(hub);
    expect(r.map((x) => [x.jobNumber, x.result, x.amount])).toEqual([[9001, "updated", 7188.14]]);
    expect(approver.asked[0].action).toMatch(/Estimate sent for #9001/);
    expect(homebase.writes.map((w) => w.op)).toEqual(["setProposal", "setStage"]);
    expect(homebase.writes[0].args).toMatchObject({ amount: 7188.14, submittedAt: "2026-11-06" });
    expect(hub.jobs.get(9001).stage).toBe("Proposal Submitted");
    // The same email is never asked about twice.
    expect(await checkProposalsSent(hub)).toEqual([]);
    expect(approver.asked).toHaveLength(1);
  });

  it("writes nothing on No, and doesn't ask again about that email", async () => {
    const { hub, gmail, homebase, approver } = testHub(false);
    await pullJob(hub, 9001);
    hub.jobs.upsert(9001, { estimate: { ...hub.jobs.get(9001).estimate, total: 5000 } });
    await sendEstimate(hub, gmail);
    expect((await checkProposalsSent(hub))[0].result).toBe("skipped");
    expect(homebase.writes).toEqual([]);
    await checkProposalsSent(hub);
    expect(approver.asked).toHaveLength(1);
  });

  it("uses an amount typed on the card", async () => {
    const { hub, gmail, homebase } = testHub();
    await pullJob(hub, 9001);
    hub.approver.confirmOrReply = async () => ({ yes: false, reply: "$6,843.25" });
    await sendEstimate(hub, gmail);
    const r = await checkProposalsSent(hub);
    expect(r[0]).toMatchObject({ result: "updated", amount: 6843.25 });
    expect(homebase.writes[0].args).toMatchObject({ amount: 6843.25 });
  });

  it("only updates the amount on a job already at Proposal Submitted, and leaves later stages alone", async () => {
    const { hub, gmail, homebase } = testHub();
    await pullJob(hub, 9001);
    hub.jobs.upsert(9001, { estimate: { ...hub.jobs.get(9001).estimate, total: 8000 } });
    await homebase.setProposal(9001, { amount: 7000, submittedAt: "2026-11-01" });
    await homebase.setStage(9001, "Proposal Submitted");
    homebase.writes.length = 0;
    await sendEstimate(hub, gmail);
    expect((await checkProposalsSent(hub))[0]).toMatchObject({ result: "updated", amount: 8000 });
    expect(homebase.writes.map((w) => w.op)).toEqual(["setProposal"]);
    await homebase.setStage(9001, "Work In Progress");
    homebase.writes.length = 0;
    await sendEstimate(hub, gmail, { at: "2026-11-09T16:00:00Z" });
    expect((await checkProposalsSent(hub))[0].result).toBe("past");
    expect(homebase.writes).toEqual([]);
  });

  it("ignores photo reports, internal emails and drafts that weren't sent", async () => {
    const { hub, gmail, approver } = testHub();
    await pullJob(hub, 9001);
    await sendEstimate(hub, gmail, { file: "Sample - Photo Report.pdf" });
    await sendEstimate(hub, gmail, { to: ["boss@forefrontteam.com"] });
    await hub.gmail.createDraft({ to: ["sam@example.com"], bcc: ["office+9001@forefrontteam.com"], subject: "Not sent", body: "x", attachments: [pdf("Sample - Reconstruction Estimate.pdf")] });
    expect(await checkProposalsSent(hub)).toEqual([]);
    expect(approver.asked).toEqual([]);
  });

  it("knows a proposal file and a typed amount when it sees one", () => {
    expect(isProposalFile("Gorrell - Xactimate Estimate.pdf")).toBe(true);
    expect(isProposalFile("Smith - Reconstruction Agreement.pdf")).toBe(true);
    expect(isProposalFile("Smith - Photo Report.pdf")).toBe(false);
    expect(isProposalFile("estimate.json")).toBe(false);
    expect(typedAmount("7,188.14")).toBe(7188.14);
    expect(typedAmount("it was $950")).toBe(950);
    expect(typedAmount("no")).toBeUndefined();
  });
});
