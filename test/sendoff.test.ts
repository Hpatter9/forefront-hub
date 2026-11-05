import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { makeGuard } from "../src/agent/guard.js";
import { pullJob } from "../src/workflows/pull.js";
import { sendoff } from "../src/workflows/sendoff.js";
import { sync } from "../src/workflows/sync.js";
import { TemplateWriter } from "../src/workflows/writer.js";
import { renderSampleEstimate, testHub } from "./helpers.js";

describe("send-off on mocks, with the real skill scripts", () => {
  it("drafts both emails with the right attachments + BCC, and touches Homebase only after sending", async () => {
    const { hub, gmail, homebase, approver } = testHub(true);
    const job = await pullJob(hub, 9001);
    expect(job).toMatchObject({ name: "Sample", companycamProjectId: "cc-9001", insurance: "claim", claimNumber: "EX-12345" });
    expect(job.adjuster.email).toBe("alex.adjuster@carrier.example");
    renderSampleEstimate(hub, 9001);

    const res = await sendoff(hub, 9001, { to: ["homeowner", "adjuster"], writer: new TemplateWriter() });
    expect(res.drafts.map((d) => d.kind)).toEqual(["homeowner", "adjuster"]);
    expect(res.proposalAmount).toBeGreaterThan(0);

    const stored = gmail.drafts();
    const home = stored.find((d) => d.input.to[0] === "jane.sample@example.com")!;
    const adj = stored.find((d) => d.input.to[0] === "alex.adjuster@carrier.example")!;
    for (const d of [home, adj]) expect(d.input.bcc).toEqual(["office+9001@forefrontteam.com"]);
    expect(home.input.attachments.map((f) => path.basename(f))).toEqual(["Sample - Reconstruction Estimate.pdf"]);
    expect(adj.input.attachments.map((f) => path.basename(f))).toEqual(["Sample - Xactimate Estimate.pdf", "Sample - Photo Report.pdf"]);
    expect(existsSync(adj.input.attachments[1])).toBe(true);
    expect(readFileSync(adj.eml, "utf8")).toContain("Content-Type: application/pdf");
    expect(home.input.body).toContain(`$${res.proposalAmount!.toLocaleString("en-US", { minimumFractionDigits: 2 })}`);

    // Not sent yet: sync must not write to Homebase.
    await sync(hub, 9001);
    expect(homebase.writes).toEqual([]);

    // Hunter sends the homeowner email: proposal amount + that date + stage, after asking.
    gmail.markSent(res.drafts[0].id, "2026-11-06T16:00:00Z");
    const out = await sync(hub, 9001);
    expect(out[0].logged).toBe(true);
    expect(homebase.writes.map((w) => [w.op, w.args])).toEqual([
      ["setProposal", { amount: res.proposalAmount, submittedAt: "2026-11-06" }],
      ["setStage", { stage: "Proposal Submitted" }],
    ]);
    expect(approver.asked.at(-1)!.action).toMatch(/Update Homebase for #9001/);

    // Running sync again changes nothing.
    await sync(hub, 9001);
    expect(homebase.writes).toHaveLength(2);
    expect(hub.jobs.get(9001).estimate.status).toBe("sent");
  });

  it("writes nothing to Homebase when Hunter says no", async () => {
    const { hub, gmail, homebase } = testHub(false);
    await pullJob(hub, 9001);
    renderSampleEstimate(hub, 9001);
    const res = await sendoff(hub, 9001, { to: ["homeowner"], writer: new TemplateWriter(), yes: true });
    gmail.markSent(res.drafts[0].id);
    await sync(hub, 9001);
    expect(homebase.writes).toEqual([]);
  });

  it("refuses to draft without the PDFs or an email address", async () => {
    const { hub } = testHub(true);
    await pullJob(hub, 9002);
    await expect(sendoff(hub, 9002, { to: ["adjuster"], writer: new TemplateWriter(), yes: true })).rejects.toThrow(/No adjuster email[\s\S]*Xactimate Estimate/);
  });
});

describe("agent guard", () => {
  it("asks and snapshots before re-rendering over an existing estimate", async () => {
    const { hub, approver } = testHub(true);
    await pullJob(hub, 9001);
    renderSampleEstimate(hub, 9001);
    const guard = makeGuard(hub);
    const dir = hub.jobs.path(9001, "estimate");
    const r = await guard("Bash", { command: `python render.py estimate.json --out "${dir}"` }, { signal: new AbortController().signal } as any);
    expect(r!.behavior).toBe("allow");
    expect(approver.asked[0].action).toMatch(/Re-render the estimate PDFs/);
    expect(existsSync(path.join(dir, "revisions", "v1", "Sample - Reconstruction Estimate.pdf"))).toBe(true);
  });

  it("keeps file writes inside the job folders and away from the skill", async () => {
    const { hub } = testHub(true);
    const guard = makeGuard(hub);
    const sig = { signal: new AbortController().signal } as any;
    expect((await guard("Write", { file_path: "/etc/passwd", content: "" }, sig))!.behavior).toBe("deny");
    expect((await guard("Write", { file_path: path.join(hub.cfg.jobsRoot, "9001 Sample", "notes", "n.txt"), content: "" }, sig))!.behavior).toBe("allow");
    expect((await guard("mcp__other__thing", {}, sig))!.behavior).toBe("deny");
  });
});
