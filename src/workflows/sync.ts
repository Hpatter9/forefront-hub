import { AT_OR_PAST_PROPOSAL } from "../core/job.js";
import type { Hub } from "../hub.js";

export interface SyncResult {
  jobNumber: number;
  sent: string[];
  logged: boolean;
  note?: string;
}

const PROPOSAL_SUBMITTED = "Proposal Submitted";

/**
 * For every job with send-off drafts: check Gmail for which ones went out. Once one has, ask, then set the proposal
 * amount AND submitted date (the real send date) in Homebase and move the job to Proposal Submitted if it's earlier
 * in the pipeline. Nothing is written to Homebase until a draft has actually been sent.
 */
export async function sync(hub: Hub, only?: number): Promise<SyncResult[]> {
  const results: SyncResult[] = [];
  for (const job of hub.jobs.list()) {
    if (only !== undefined && job.jobNumber !== only) continue;
    const pending = job.sendoff.drafts.filter((d) => !d.sentAt);
    if (!job.sendoff.drafts.length) continue;

    const drafts = [...job.sendoff.drafts];
    const sent: string[] = [];
    for (const d of pending) {
      const s = await hub.gmail.draftStatus({ id: d.id, messageId: d.messageId });
      if (s.state === "sent") {
        d.sentAt = s.sentAt;
        sent.push(`${d.kind} (${s.sentAt?.slice(0, 10)})`);
      } else if (s.state === "gone") hub.say(`#${job.jobNumber}: the ${d.kind} draft was deleted without sending.`);
    }
    if (sent.length) hub.jobs.upsert(job.jobNumber, { sendoff: { ...job.sendoff, drafts } });

    const res: SyncResult = { jobNumber: job.jobNumber, sent, logged: !!job.sendoff.homebaseLoggedAt };
    results.push(res);
    const sentDrafts = drafts.filter((d) => d.sentAt);
    if (job.sendoff.homebaseLoggedAt || !sentDrafts.length) continue;

    const amount = job.sendoff.proposalAmount;
    if (!amount) {
      res.note = "sent, but no proposal amount on file; set it with `hub job set --total`";
      continue;
    }
    // The proposal date is when the homeowner got it (or the first email that went, if no homeowner email).
    const proposalDraft = sentDrafts.find((d) => d.kind === "homeowner") ?? sentDrafts.sort((a, b) => a.sentAt!.localeCompare(b.sentAt!))[0];
    const date = toLocalDate(proposalDraft.sentAt!);

    const hb = await hub.homebase.getJob(job.jobNumber);
    const sameAmount = hb.proposalAmount !== undefined && Math.abs(hb.proposalAmount - amount) < 0.005;
    const needProposal = !(sameAmount && hb.proposalSubmittedAt);
    const needStage = !AT_OR_PAST_PROPOSAL.has(hb.stage);
    // The real Homebase API stamps the proposal date as the day of the write; it can't be backdated.
    const today = toLocalDate(new Date().toISOString());
    const stampsToday = hub.homebase.kind === "api" && date !== today;

    if (!needProposal && !needStage) {
      hub.jobs.upsert(job.jobNumber, { sendoff: { ...hub.jobs.get(job.jobNumber).sendoff, homebaseLoggedAt: new Date().toISOString() } });
      res.logged = true;
      res.note = "Homebase already up to date";
      continue;
    }

    const details = [
      needProposal ? `Proposal amount ${usd(amount)} (Homebase now: ${hb.proposalAmount !== undefined ? usd(hb.proposalAmount) : "blank"})` : "",
      needProposal ? `Proposal submitted ${date} (Homebase now: ${hb.proposalSubmittedAt || "blank"}); this starts the Day 2/5/10/21 follow-ups` : "",
      needProposal && stampsToday ? `Note: Homebase records today's date (${today}) for the proposal, not ${date}; it can't be backdated. Fix the date on the job page if it matters.` : "",
      needStage ? `Stage ${hb.stage || "?"} -> ${PROPOSAL_SUBMITTED}` : `Stage stays ${hb.stage}`,
    ].filter(Boolean);
    if (!(await hub.approver.confirm(`Update Homebase for #${job.jobNumber} ${job.name}?`, details))) {
      res.note = "skipped";
      continue;
    }
    if (needProposal) await hub.homebase.setProposal(job.jobNumber, { amount, submittedAt: date });
    if (needStage) await hub.homebase.setStage(job.jobNumber, PROPOSAL_SUBMITTED, hb.stage);
    const now = new Date().toISOString();
    const latest = hub.jobs.get(job.jobNumber);
    hub.jobs.upsert(job.jobNumber, {
      stage: needStage ? PROPOSAL_SUBMITTED : latest.stage,
      estimate: { ...latest.estimate, status: "sent" },
      sendoff: { ...latest.sendoff, sentAt: proposalDraft.sentAt, homebaseLoggedAt: now },
    });
    hub.jobs.log(job.jobNumber, `Homebase: proposal ${usd(amount)} on ${date}${needStage ? `, stage -> ${PROPOSAL_SUBMITTED}` : ""}`);
    res.logged = true;
    hub.say(`#${job.jobNumber}: Homebase updated.`);
  }
  return results;
}

/** Homebase dates are local (Colorado) calendar dates. */
export function toLocalDate(iso: string, tz = "America/Denver"): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date(iso));
}

const usd = (n: number) => `$${n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
