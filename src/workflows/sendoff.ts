import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { intakeAddress } from "../connectors/homebase/types.js";
import type { SendoffDraft } from "../core/job.js";
import type { Hub } from "../hub.js";
import { downloadPhotos } from "./pull.js";
import type { EmailWriter, PhotoInfo, Recipient } from "./writer.js";

export interface SendoffOptions {
  to: Recipient[];
  writer: EmailWriter;
  cc?: string[];
  /** Skip the "create these drafts?" question. Drafts are never sent either way. */
  yes?: boolean;
  /** Reuse an existing photo report in estimate/ instead of building a new one. */
  reusePhotoReport?: boolean;
}

export interface SendoffResult {
  drafts: SendoffDraft[];
  proposalAmount?: number;
  skipped?: string;
}

export function estimateFiles(hub: Hub, jobNumber: number) {
  const pdfs = hub.jobs.files(jobNumber, "estimate", /\.pdf$/i);
  const find = (suffix: string) => pdfs.find((f) => f.endsWith(suffix));
  const json = hub.jobs.path(jobNumber, "estimate", "estimate.json");
  return {
    estimate: find("- Reconstruction Estimate.pdf"),
    agreement: find("- Reconstruction Agreement.pdf"),
    xactimate: find("- Xactimate Estimate.pdf"),
    photoReport: find("- Photo Report.pdf"),
    estimateJson: existsSync(json) ? json : undefined,
  };
}

/**
 * Send-off: Gmail drafts (never sent) for the homeowner and/or adjuster with the right PDFs attached and the job's
 * Homebase log address BCC'd. Homebase is NOT touched here: `hub sync` sets the proposal amount + date and the
 * stage once Gmail shows the drafts actually went out, so the follow-up sequence starts on the real send date.
 */
export async function sendoff(hub: Hub, jobNumber: number, o: SendoffOptions): Promise<SendoffResult> {
  const job = hub.jobs.get(jobNumber);
  const files = estimateFiles(hub, jobNumber);
  const problems: string[] = [];

  // ---- totals, from the skill's own math
  let total = job.estimate.total;
  let xactimateTotal: number | undefined;
  if (files.estimateJson) {
    const scopes = await hub.skill.totals(files.estimateJson);
    const base = scopes.find((s) => s.title === "Base Scope");
    if (base) {
      total = base.customerTotal;
      xactimateTotal = base.xactimateTotal;
    }
  }
  const est = files.estimateJson ? JSON.parse(readFileSync(files.estimateJson, "utf8")) : {};

  // ---- who gets what
  const plan: { kind: Recipient; to: string; attachments: string[] }[] = [];
  for (const kind of o.to) {
    if (kind === "homeowner") {
      if (!job.customer.email) problems.push("No homeowner email (Homebase contact or `hub job set` it).");
      if (!files.estimate) problems.push("No '<Last Name> - Reconstruction Estimate.pdf' in estimate/.");
      plan.push({ kind, to: job.customer.email, attachments: [files.estimate ?? ""] });
    } else {
      if (!job.adjuster.email) problems.push("No adjuster email (Homebase contact or `hub job set --adjuster-email`).");
      if (!files.xactimate) problems.push("No '<Last Name> - Xactimate Estimate.pdf' in estimate/.");
      plan.push({ kind, to: job.adjuster.email, attachments: [files.xactimate ?? ""] }); // + photo report below
    }
  }
  if (total === undefined && o.to.includes("homeowner")) problems.push("No estimate total (no estimate/estimate.json).");
  if (problems.length) throw new Error(`Can't draft the send-off for #${jobNumber}:\n  - ${problems.join("\n  - ")}`);

  const bcc = intakeAddress(jobNumber);
  const lines = plan.map((p) => `${p.kind.padEnd(9)} -> ${p.to}  [${p.attachments.map((a) => path.basename(a)).join(", ")}${p.kind === "adjuster" ? ", photo report" : ""}]`);
  if (!o.yes) {
    const ok = await hub.approver.confirm(`Draft the send-off for #${jobNumber} ${job.name}? (drafts only; nothing is sent)`, [
      ...lines,
      `bcc ${bcc}`,
      total !== undefined ? `total ${usd(total)}${xactimateTotal !== undefined ? `  (Xactimate ${usd(xactimateTotal)})` : ""}` : "",
    ].filter(Boolean));
    if (!ok) return { drafts: [], skipped: "cancelled" };
  }

  // ---- photo report for the adjuster
  const adj = plan.find((p) => p.kind === "adjuster");
  if (adj) {
    let report = o.reusePhotoReport ? files.photoReport : undefined;
    if (!report) report = await buildPhotoReport(hub, jobNumber, o.writer, files.estimateJson);
    adj.attachments.push(report);
  }

  // ---- drafts
  const drafts: SendoffDraft[] = [];
  for (const p of plan) {
    const { subject, body } = await o.writer.writeEmail({
      job,
      kind: p.kind,
      total,
      xactimateTotal,
      attachments: p.attachments.map((a) => path.basename(a)),
      priceList: est.price_list,
    });
    const ref = await hub.gmail.createDraft({ to: [p.to], cc: o.cc, bcc: [bcc], subject, body, attachments: p.attachments });
    const d: SendoffDraft = { id: ref.id, kind: p.kind, to: [p.to], subject, messageId: ref.messageId, attachments: p.attachments.map((a) => path.basename(a)), createdAt: new Date().toISOString() };
    drafts.push(d);
    writeFileSync(hub.jobs.path(jobNumber, "email", `${d.createdAt.slice(0, 10)}-${p.kind}.txt`), `To: ${p.to}\nBcc: ${bcc}\nSubject: ${subject}\nAttachments: ${d.attachments.join(", ")}\n\n${body}\n`);
    hub.say(`Draft for ${p.kind}: "${subject}" -> ${p.to} (bcc ${bcc})`);
  }

  const latest = hub.jobs.get(jobNumber);
  hub.jobs.upsert(jobNumber, {
    estimate: { ...latest.estimate, total: total ?? latest.estimate.total },
    sendoff: { drafts: [...latest.sendoff.drafts, ...drafts], proposalAmount: o.to.includes("homeowner") || latest.sendoff.proposalAmount === undefined ? total : latest.sendoff.proposalAmount, homebaseLoggedAt: null },
  });
  hub.jobs.log(jobNumber, `Send-off drafted: ${drafts.map((d) => d.kind).join(" + ")}`);
  hub.say("Review the drafts in Gmail and send them. Then run `hub sync` to log the proposal in Homebase.");
  return { drafts, proposalAmount: total };
}

async function buildPhotoReport(hub: Hub, jobNumber: number, writer: EmailWriter, estimateJson?: string): Promise<string> {
  const photosDir = hub.jobs.path(jobNumber, "photos");
  const indexFile = path.join(photosDir, "index.json");
  if (!existsSync(indexFile)) await downloadPhotos(hub, jobNumber);
  const photos: PhotoInfo[] = JSON.parse(readFileSync(indexFile, "utf8"));
  if (!photos.length) throw new Error("No photos for the photo report (CompanyCam project is empty).");
  const job = hub.jobs.get(jobNumber);
  const picks = await writer.pickPhotos(job, photos, photosDir);
  const picksFile = path.join(photosDir, "report-picks.json");
  writeFileSync(
    picksFile,
    JSON.stringify({ customer: job.customer.name || undefined, address: job.address || undefined, claim_number: job.claimNumber || undefined, date_of_loss: job.dateOfLoss || undefined, photos: picks }, null, 2),
  );
  const out = await hub.skill.photoReport({ picks: picksFile, photosDir, estimateJson, outDir: hub.jobs.path(jobNumber, "estimate") });
  hub.say(`Photo report: ${out} (${picks.length} photos)`);
  return out;
}

const usd = (n: number) => `$${n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
