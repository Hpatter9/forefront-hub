import { intakeAddress } from "../connectors/homebase/types.js";
import type { Job } from "../core/job.js";
import type { Hub } from "../hub.js";
import { STANDARD_FILES } from "./files.js";

/**
 * The Today screen: what needs Hunter's attention, worked out from each job folder's job.json (kept fresh by the
 * background sync). Nothing here writes anywhere.
 */
export type ReminderKind = "reply" | "estimate" | "followup" | "stale" | "log" | "upload" | "draft";

export interface Reminder {
  kind: ReminderKind;
  jobNumber: number;
  name: string;
  stage: string;
  title: string;
  detail: string;
  /** Days since the thing that started the clock. */
  days: number;
  threadId?: string;
}

export const REMINDER_GROUPS: { kind: ReminderKind; label: string; hint: string }[] = [
  { kind: "reply", label: "Reply needed", hint: "Someone on the job emailed and there's no answer from you after it" },
  { kind: "log", label: "Sent, log it in Homebase", hint: "Send-offs that went out; log the proposal" },
  { kind: "estimate", label: "Needs an estimate", hint: "Lead through Estimating with no proposal yet" },
  { kind: "followup", label: "Follow up on proposals", hint: "Proposal Submitted and quiet for 5+ days" },
  { kind: "draft", label: "Drafts waiting to send", hint: "Send-off drafts still sitting in Gmail" },
  { kind: "upload", label: "Files Homebase doesn't have", hint: "Estimate PDFs to upload" },
  { kind: "stale", label: "Not touched this week", hint: "No call, email or note in 7+ days" },
];

const PRE_ESTIMATE = new Set(["Qualify", "Lead", "FDA", "Scope Walk", "Adjustment", "Estimating", "Proposal Review"]);
const DONE = new Set(["Payment Received", "Closed Lost", "Invoiced", "Sent To Insurance", "Lien/Collections"]);
const days = (iso: string) => (iso && !Number.isNaN(Date.parse(iso)) ? Math.max(0, Math.floor((Date.now() - Date.parse(iso)) / 864e5)) : 999);

export function reminders(hub: Hub, extras: { needsUpload?: Set<number> } = {}): Reminder[] {
  const out: Reminder[] = [];
  for (const j of hub.jobs.list()) {
    if (DONE.has(j.stage)) continue;
    const base = { jobNumber: j.jobNumber, name: j.name, stage: j.stage };
    const p = j.pulse;
    if (p.waiting) out.push({ ...base, kind: "reply", title: p.waiting.subject || "(no subject)", detail: `from ${p.waiting.from}`, days: days(p.waiting.at), threadId: p.waiting.threadId || undefined });

    const sent = j.sendoff.drafts.filter((d) => d.sentAt);
    if (sent.length && !j.sendoff.homebaseLoggedAt) out.push({ ...base, kind: "log", title: "Send-off went out", detail: sent.map((d) => d.kind).join(" + "), days: days(sent[0].sentAt!) });
    const unsent = j.sendoff.drafts.filter((d) => !d.sentAt);
    if (unsent.length) out.push({ ...base, kind: "draft", title: unsent.map((d) => d.subject).join("; "), detail: `to ${unsent.flatMap((d) => d.to).join(", ")}`, days: days(unsent[0].createdAt) });

    // The clock for "quiet" starts at the last touch, else when the job entered its stage.
    const quiet = days(p.lastTouchAt || j.stageSince);
    const needsEstimate = PRE_ESTIMATE.has(j.stage) && !p.proposalAmount && !hasEstimate(hub, j);
    if (needsEstimate) out.push({ ...base, kind: "estimate", title: `${j.stage}, no estimate yet`, detail: j.address, days: days(j.stageSince) });
    if (j.stage === "Proposal Submitted" && quiet >= 5 && !p.waiting) {
      out.push({ ...base, kind: "followup", title: p.proposalAmount ? `$${p.proposalAmount.toLocaleString("en-US", { minimumFractionDigits: 2 })} proposal` : "Proposal out", detail: p.lastTouch ? `last: ${p.lastTouch}` : `in stage since ${j.stageSince}`, days: quiet });
    } else if (!needsEstimate && !p.waiting && p.checkedAt && quiet >= 7 && quiet < 999) {
      out.push({ ...base, kind: "stale", title: p.lastTouch ? `Last: ${p.lastTouch}` : "No activity on record", detail: j.stage, days: quiet });
    }
    if (extras.needsUpload?.has(j.jobNumber)) out.push({ ...base, kind: "upload", title: "Estimate files not in Homebase", detail: "", days: 0 });
  }
  return out.sort((a, b) => b.days - a.days);
}

function hasEstimate(hub: Hub, j: Job) {
  return hub.jobs.files(j.jobNumber, "estimate", /\.pdf$/i).some((f) => STANDARD_FILES.some((s) => f.endsWith(s.suffix)));
}

/**
 * Works out a job's pulse: when it was last touched (Homebase notes, Activity, filed emails, Gmail) and whether the
 * newest email from someone else is still waiting on an answer from Hunter.
 */
export async function pulse(hub: Hub, j: Job): Promise<Job["pulse"]> {
  const me = hub.cfg.gmail.address.toLowerCase();
  const touches: { at: string; what: string }[] = [];
  const [detail, activity, emails] = await Promise.all([
    hub.homebase.getJob(j.jobNumber).catch(() => null),
    hub.homebase.activity?.(j.jobNumber).catch(() => []) ?? Promise.resolve([]),
    hub.homebase.emails?.(j.jobNumber).catch(() => []) ?? Promise.resolve([]),
  ]);
  for (const n of detail?.notes ?? []) touches.push({ at: n.at, what: "note" });
  for (const a of activity) touches.push({ at: a.on, what: `${a.type.toLowerCase()}: ${a.subject}` });
  for (const e of emails) {
    if (e.direction === "in" && isAutomated(e.from, e.fromName ?? "", e.subject)) continue; // a receipt isn't a touch
    touches.push({ at: e.sentAt, what: `${e.direction === "out" ? "emailed" : "email from"} ${e.direction === "out" ? e.to[0] ?? "" : e.fromName || e.from}` });
  }

  let waiting: Job["pulse"]["waiting"] = null;
  if (hub.gmail.kind === "google") {
    const people = [j.customer.email, j.adjuster.email].filter(Boolean);
    const street = j.address.split(",")[0];
    const q = [...people.map((p) => `from:${p}`), `"${intakeAddress(j.jobNumber)}"`, street ? `"${street}"` : ""].filter(Boolean).join(" OR ");
    const threads = q ? await hub.gmail.search(`(${q}) newer_than:60d -from:me`, 8).catch(() => []) : [];
    for (const t of threads) {
      // search() summarises each thread by its newest message: if that one isn't from Hunter, it's waiting on him.
      const at = new Date(t.date).toISOString();
      touches.push({ at, what: `email: ${t.subject}` });
      if (!t.from.toLowerCase().includes(me) && !isAutomated(t.from, "", t.subject) && (!waiting || at > waiting.at)) {
        waiting = { from: t.from.replace(/<.*>/, "").trim() || t.from, subject: t.subject, at, threadId: t.id };
      }
    }
  } else {
    // Without Gmail: the newest filed email from a person (not a system notice) and nothing went out after it.
    const sorted = [...emails].filter((e) => !(e.direction === "in" && isAutomated(e.from, e.fromName ?? "", e.subject))).sort((a, b) => b.sentAt.localeCompare(a.sentAt));
    if (sorted[0]?.direction === "in") waiting = { from: sorted[0].fromName || sorted[0].from, subject: sorted[0].subject, at: sorted[0].sentAt, threadId: "" };
  }
  // A note, call or email from Hunter after it answers it.
  if (waiting) {
    const after = touches.some((t) => t.at > waiting!.at && !t.what.startsWith("email from") && !t.what.startsWith("email:"));
    if (after) waiting = null;
  }
  touches.sort((a, b) => b.at.localeCompare(a.at));
  return { lastTouchAt: touches[0]?.at ?? "", lastTouch: touches[0]?.what ?? "", waiting, proposalAmount: detail?.proposalAmount ?? null, checkedAt: new Date().toISOString() };
}

/** System notices nobody answers: payment receipts, portals, no-reply senders. */
export function isAutomated(from: string, fromName: string, subject: string): boolean {
  return /no-?reply|do-?not-?reply|notifications?@|quickbooks|intuit|docusketch|companycam|mailer-daemon|postmaster/i.test(`${from} ${fromName}`) || /payment received|invoice #|receipt|delivery status notification|out of office|automatic reply/i.test(subject);
}
