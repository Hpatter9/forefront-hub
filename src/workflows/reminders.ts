import { intakeAddress } from "../connectors/homebase/types.js";
import type { Job } from "../core/job.js";
import type { Hub } from "../hub.js";
import { STANDARD_FILES } from "./files.js";

/**
 * The Today screen: what needs Hunter's attention, worked out from each job folder's job.json (kept fresh by the
 * background sync). Nothing here writes anywhere.
 */
export type ReminderKind = "reply" | "adjuster" | "walk" | "estimate" | "followup" | "stale" | "log" | "upload" | "draft";

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
  /** Where the job is, in plain words: the one next step for its stage (a Lead's is the scope walk, not the estimate). */
  step: string;
  /** When the brief last asked for this job's follow-up (so it comes up about twice a week, not daily). */
  nudgedAt?: string;
}

/** The next step for each stage, in order: walk first, then the estimate, then the proposal. */
export const STAGE_STEP: Record<string, string> = {
  Qualify: "Qualify the lead, then set up the scope walk",
  Lead: "Set up the scope walk (the estimate comes after the walk)",
  FDA: "Finish the site visit, then write the estimate",
  "Scope Walk": "Do the scope walk (book it if it isn't on the calendar), then write the estimate",
  Adjustment: "Settle the scope with the adjuster, then write the estimate",
  Estimating: "Write the estimate",
  "Proposal Review": "Review the proposal and send it",
  "Proposal Submitted": "Follow up on the proposal",
  Supplement: "Work the supplement with the adjuster",
};
export const stepFor = (stage: string) => STAGE_STEP[stage] ?? "Check on the job";

/** Customer follow-ups come up about twice a week: this many days after the last contact or the last nudge. */
export const FOLLOWUP_EVERY = Number(process.env.HUB_FOLLOWUP_DAYS || 3);

export const REMINDER_GROUPS: { kind: ReminderKind; label: string; hint: string }[] = [
  { kind: "reply", label: "Reply needed", hint: "Someone on the job emailed and there's no answer from you after it" },
  { kind: "adjuster", label: "Check in with the adjuster", hint: "Estimate is with the adjuster and you haven't been in touch for 7+ days" },
  { kind: "log", label: "Sent, log it in Homebase", hint: "Send-offs that went out; log the proposal" },
  { kind: "walk", label: "Set up a scope walk", hint: "Leads that need their walk before the estimate" },
  { kind: "estimate", label: "Needs an estimate", hint: "Walk stage through Estimating with no proposal yet" },
  { kind: "followup", label: "Follow up on proposals", hint: "Proposal Submitted and no contact for 3+ days (about twice a week)" },
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
    const base = { jobNumber: j.jobNumber, name: j.name, stage: j.stage, step: stepFor(j.stage), nudgedAt: j.followups?.nudgedAt || undefined };
    const p = j.pulse;
    // An email waits on a reply unless you texted them after it; a text waits unless you emailed, called or noted after it.
    const tx = j.texts;
    const emailWaiting = p.waiting && !(tx?.lastFromMeAt && tx.lastFromMeAt > p.waiting.at) ? p.waiting : null;
    const textWaiting = tx?.waiting && days(tx.waiting.at) <= REPLY_DAYS && !(p.lastTouchAt && p.lastTouchAt > tx.waiting.at && !/^email from|^email:/.test(p.lastTouch)) ? tx.waiting : null;
    if (emailWaiting) out.push({ ...base, kind: "reply", title: emailWaiting.subject || "(no subject)", detail: `from ${emailWaiting.from}`, days: days(emailWaiting.at), threadId: emailWaiting.threadId || undefined });
    if (textWaiting) out.push({ ...base, kind: "reply", title: `Text: ${textWaiting.text}`, detail: `text from ${textWaiting.from} (answer on your phone)`, days: days(textWaiting.at) });
    const waitingOnMe = !!(emailWaiting || textWaiting);

    const sent = j.sendoff.drafts.filter((d) => d.sentAt);
    if (sent.length && !j.sendoff.homebaseLoggedAt) out.push({ ...base, kind: "log", title: "Send-off went out", detail: sent.map((d) => d.kind).join(" + "), days: days(sent[0].sentAt!) });
    const unsent = j.sendoff.drafts.filter((d) => !d.sentAt);
    if (unsent.length) out.push({ ...base, kind: "draft", title: unsent.map((d) => d.subject).join("; "), detail: `to ${unsent.flatMap((d) => d.to).join(", ")}`, days: days(unsent[0].createdAt) });

    // The clock for "quiet" starts at the last touch, else when the job entered its stage.
    // A follow-up you ticked off in the brief counts as contact too.
    // ...and so does a text either way.
    const touchedAt = [p.lastTouchAt, j.followups?.doneAt, tx?.lastAt].filter(Boolean).sort().at(-1) ?? "";
    const quiet = days(touchedAt || j.stageSince);
    const needsEstimate = PRE_ESTIMATE.has(j.stage) && !p.proposalAmount && !hasEstimate(hub, j);
    if (needsEstimate && (j.stage === "Lead" || j.stage === "Qualify")) out.push({ ...base, kind: "walk", title: `${j.stage}: set up the scope walk`, detail: j.address, days: days(j.stageSince) });
    else if (needsEstimate) out.push({ ...base, kind: "estimate", title: `${j.stage}: ${stepFor(j.stage).toLowerCase()}`, detail: j.address, days: days(j.stageSince) });
    // The adjuster check-in: a claim whose estimate is with the adjuster, and a week since you were last in touch.
    const adj = adjusterReview(j);
    if (adj && !waitingOnMe && adj.days >= ADJUSTER_DAYS) {
      out.push({ ...base, kind: "adjuster", title: `Check in with ${adj.who} on the review status`, detail: adj.since, days: adj.days });
    } else if (j.stage === "Proposal Submitted" && quiet >= FOLLOWUP_EVERY && !waitingOnMe) {
      out.push({ ...base, kind: "followup", title: p.proposalAmount ? `$${p.proposalAmount.toLocaleString("en-US", { minimumFractionDigits: 2 })} proposal` : "Proposal out", detail: p.lastTouch ? `last: ${p.lastTouch}` : `in stage since ${j.stageSince}`, days: quiet });
    } else if (!needsEstimate && !waitingOnMe && p.checkedAt && quiet >= 7 && quiet < 999) {
      out.push({ ...base, kind: "stale", title: p.lastTouch ? `Last: ${p.lastTouch}` : "No activity on record", detail: j.stage, days: quiet });
    }
    if (extras.needsUpload?.has(j.jobNumber)) out.push({ ...base, kind: "upload", title: "Estimate files not in Homebase", detail: "", days: 0 });
  }
  return out.sort((a, b) => b.days - a.days);
}

/** An email waits on a reply only for this long (HUB_REPLY_DAYS); after that it was dealt with some other way. */
export const REPLY_DAYS = Number(process.env.HUB_REPLY_DAYS || 21);

/**
 * Whether the newest email in a thread is written to Hunter: he's on the To line. Cc'd only, or sent just to the
 * office or someone else, it's for his information and not a reply he owes. (No To line known: counts.)
 */
export function addressedToMe(t: { to?: string; cc?: string }, me: string): boolean {
  if (t.to === undefined || !t.to.trim()) return true;
  return t.to.toLowerCase().includes(me.toLowerCase());
}

/** Stages where the work is Hunter's (estimating through the proposal and supplements); later stages belong to the PM. */
const ESTIMATOR_STAGES = new Set([...PRE_ESTIMATE, "Proposal Submitted", "Supplement"]);
/** How recent each kind of item has to be for the brief (days since its clock started). */
export const BRIEF_MAX_DAYS: Record<ReminderKind, number> = { reply: REPLY_DAYS, adjuster: 45, followup: 45, stale: 30, walk: 60, estimate: 60, log: 30, draft: 30, upload: 30 };

/**
 * The reminders that belong in Hunter's brief: his own action items, and recent ones. Leaves out quiet jobs that
 * are in someone else's stage (production, billing), and anything old enough that it's no longer today's work
 * (it still shows on the dashboard). Returns what was left out, so the brief can say so.
 */
export function briefItems(list: Reminder[]): { items: Reminder[]; left: Reminder[] } {
  const items: Reminder[] = [];
  const left: Reminder[] = [];
  for (const r of list) {
    const notMine = (r.kind === "stale" || r.kind === "followup") && !ESTIMATOR_STAGES.has(r.stage);
    const old = r.days > (BRIEF_MAX_DAYS[r.kind] ?? 30);
    // Follow-ups twice a week: if the brief already asked in the last few days, it waits.
    const askedLately = (r.kind === "followup" || r.kind === "stale") && !!r.nudgedAt && days(r.nudgedAt) < FOLLOWUP_EVERY;
    (notMine || old || askedLately ? left : items).push(r);
  }
  return { items, left };
}

/** Days without contact before the adjuster check-in shows (HUB_ADJUSTER_DAYS to change it). */
export const ADJUSTER_DAYS = Number(process.env.HUB_ADJUSTER_DAYS || 7);
/** Stages where the estimate is sitting with the adjuster. */
const WITH_ADJUSTER = new Set(["Adjustment", "Proposal Review", "Proposal Submitted", "Supplement"]);

/** When a job's estimate is with the adjuster: who, and how long since you were last in touch with them. */
export function adjusterReview(j: Job): { who: string; days: number; since: string } | null {
  if (!j.adjuster.email && !j.adjuster.name) return null;
  if (j.insurance === "oop") return null;
  const sentToAdjuster = j.sendoff.drafts.filter((d) => d.kind === "adjuster" && d.sentAt).map((d) => d.sentAt!).sort().at(-1);
  if (!WITH_ADJUSTER.has(j.stage) && !(sentToAdjuster && !DONE.has(j.stage) && !["Job Won", "Closed Lost"].includes(j.stage))) return null;
  const p = j.pulse;
  // A text with the adjuster counts as being in touch.
  const adjText = j.texts?.last.endsWith(j.adjuster.name) && j.adjuster.name ? j.texts.lastAt : "";
  const clocks = [p.adjusterTouchAt, sentToAdjuster, adjText, j.stageSince].filter((x): x is string => !!x && !Number.isNaN(Date.parse(x)));
  if (!clocks.length) return null;
  const last = clocks.sort().at(-1)!;
  const who = (j.adjuster.name || j.adjuster.email).split(/\s+/)[0] || "the adjuster";
  const since = p.adjusterTouchAt === last && p.adjusterTouch ? `last: ${p.adjusterTouch}` : sentToAdjuster === last ? "estimate sent, no word since" : `in ${j.stage} since ${j.stageSince}`;
  return { who: who.includes("@") ? "the adjuster" : who, days: days(last), since };
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
  // Contact with the adjuster: an email to or from them (filed in Homebase or in Gmail), or a call logged with them.
  const adjEmail = j.adjuster.email.toLowerCase();
  const adjLast = (j.adjuster.name.split(/\s+/).at(-1) ?? "").toLowerCase();
  const adjTouches: { at: string; what: string }[] = [];
  for (const e of emails) {
    const people = [e.from, ...e.to].map((x) => x.toLowerCase());
    if (adjEmail && people.some((x) => x.includes(adjEmail))) adjTouches.push({ at: e.sentAt, what: `${e.direction === "out" ? "you emailed" : "they emailed"}: ${e.subject}` });
  }
  for (const a of activity) {
    const who = `${a.who ?? ""} ${a.subject ?? ""}`.toLowerCase();
    if ((adjLast.length >= 3 && who.includes(adjLast)) || (adjEmail && who.includes(adjEmail))) adjTouches.push({ at: a.on, what: `${a.type.toLowerCase()}: ${a.subject}` });
  }
  for (const e of emails) {
    if (e.direction === "in" && isAutomated(e.from, e.fromName ?? "", e.subject)) continue; // a receipt isn't a touch
    touches.push({ at: e.sentAt, what: `${e.direction === "out" ? "emailed" : "email from"} ${e.direction === "out" ? e.to[0] ?? "" : e.fromName || e.from}` });
  }

  let waiting: Job["pulse"]["waiting"] = null;
  // Gmail is asked about each job at most once an hour (Google limits requests per minute); in between, the last
  // answer stands.
  const gmailFresh = j.pulse.gmailCheckedAt && Date.now() - Date.parse(j.pulse.gmailCheckedAt) < 60 * 60_000;
  if (hub.gmail.kind === "google" && gmailFresh) {
    waiting = j.pulse.waiting;
  } else if (hub.gmail.kind === "google") {
    const people = [j.customer.email, j.adjuster.email].filter(Boolean);
    const street = j.address.split(",")[0];
    // The street only counts in the subject: "123 Main St" in someone's signature or an unrelated email isn't this job.
    const q = [...people.map((p) => `from:${p}`), `"${intakeAddress(j.jobNumber)}"`, street ? `subject:"${street}"` : ""].filter(Boolean).join(" OR ");
    const threads = q ? await hub.gmail.search(`(${q}) newer_than:60d -from:me`, 5).catch(() => []) : [];
    if (adjEmail) {
      const [last] = await hub.gmail.search(`(from:${adjEmail} OR to:${adjEmail} OR cc:${adjEmail}) newer_than:180d`, 1).catch(() => []);
      if (last) adjTouches.push({ at: new Date(last.date).toISOString(), what: `${last.from.toLowerCase().includes(me) ? "you emailed" : "they emailed"}: ${last.subject}` });
    }
    // Emails you sent yourself (a new email, not a reply) count as contact too: the search above skips them.
    if (people.length) {
      const sent = await hub.gmail.search(`from:me (${people.map((p) => `to:${p} OR cc:${p}`).join(" OR ")}) newer_than:60d`, 3).catch(() => []);
      for (const t of sent) touches.push({ at: new Date(t.date).toISOString(), what: `you emailed: ${t.subject}` });
    }
    for (const t of threads) {
      // search() summarises each thread by its newest message: if that one isn't from Hunter, it's waiting on him.
      const at = new Date(t.date).toISOString();
      touches.push({ at, what: `email: ${t.subject}` });
      if (!t.from.toLowerCase().includes(me) && !isAutomated(t.from, "", t.subject) && addressedToMe(t, me) && days(at) <= REPLY_DAYS && (!waiting || at > waiting.at)) {
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
  const gmailCheckedAt = hub.gmail.kind === "google" && !gmailFresh ? new Date().toISOString() : j.pulse.gmailCheckedAt ?? "";
  if (gmailFresh && j.pulse.lastTouchAt && (!touches[0] || j.pulse.lastTouchAt > touches[0].at)) touches.unshift({ at: j.pulse.lastTouchAt, what: j.pulse.lastTouch });
  // Homebase rarely names the adjuster: work it out from who writes about the claim.
  let adjusterGuess: Job["pulse"]["adjusterGuess"] = j.pulse.adjusterGuess ?? null;
  if (!adjEmail && j.insurance !== "oop" && (j.claimNumber || j.carrier || j.insurance === "claim")) {
    const people = emails.flatMap((e) => (e.direction === "in" ? [{ addr: e.from, name: e.fromName ?? "", text: `${e.subject} ${e.preview ?? ""}`, at: e.sentAt }] : e.to.map((t) => ({ addr: t, name: "", text: `${e.subject} ${e.preview ?? ""}`, at: e.sentAt }))));
    if (hub.gmail.kind === "google" && j.claimNumber && !gmailFresh) {
      for (const t of await hub.gmail.search(`"${j.claimNumber}" newer_than:365d`, 10).catch(() => [])) people.push({ addr: t.from, name: "", text: `${t.subject} ${t.snippet}`, at: t.date });
    }
    adjusterGuess = guessAdjuster(j, people, me) ?? adjusterGuess;
  }
  adjTouches.sort((a, b) => b.at.localeCompare(a.at));
  // Between hourly Gmail checks, keep the newer of what Homebase shows now and what Gmail showed last time.
  const adjNow = adjTouches[0] && (!j.pulse.adjusterTouchAt || adjTouches[0].at > j.pulse.adjusterTouchAt) ? adjTouches[0] : { at: j.pulse.adjusterTouchAt, what: j.pulse.adjusterTouch };
  return { lastTouchAt: touches[0]?.at ?? "", lastTouch: touches[0]?.what ?? "", waiting, proposalAmount: detail?.proposalAmount ?? null, checkedAt: new Date().toISOString(), gmailCheckedAt, adjusterTouchAt: adjNow.at ?? "", adjusterTouch: adjNow.what ?? "", adjusterGuess };
}

const PERSONAL = /@(gmail|yahoo|hotmail|outlook|icloud|me|aol|comcast|msn|live|att|protonmail|mac)\./i;
/**
 * The job's adjuster, worked out from the people on its emails: someone outside Forefront who isn't the customer,
 * writing from a company address, best of all about this claim number or from the carrier's own domain.
 */
export function guessAdjuster(j: Job, people: { addr: string; name: string; text: string; at: string }[], me: string): { name: string; email: string; why: string } | null {
  const norm = (s: string) => s.replace(/[\s-]/g, "").toLowerCase();
  const claim = j.claimNumber && norm(j.claimNumber).length >= 5 ? norm(j.claimNumber) : "";
  const carrier = j.carrier.toLowerCase().replace(/insurance|ins\.?|company|co\.?|group|mutual|\W/g, "");
  const customer = j.customer.email.toLowerCase();
  const score = new Map<string, { name: string; email: string; s: number; why: Set<string> }>();
  for (const p of people) {
    const email = p.addr.match(/[\w.+-]+@[\w.-]+\.\w+/)?.[0]?.toLowerCase() ?? "";
    if (!email || email === me || email === customer || email.endsWith("@forefrontteam.com") || isAutomated(p.addr, p.name, p.text)) continue;
    const name = p.name || p.addr.replace(/<.*>/, "").replace(/"/g, "").trim();
    const x = score.get(email) ?? { name: name.includes("@") ? "" : name, email, s: 0, why: new Set<string>() };
    if (!x.name && name && !name.includes("@")) x.name = name;
    x.s += 1;
    if (claim && norm(p.text).includes(claim)) { x.s += 3; x.why.add("writes about the claim number"); }
    if (carrier.length >= 4 && email.split("@")[1].replace(/\W/g, "").includes(carrier.slice(0, 8))) { x.s += 3; x.why.add(`${j.carrier} address`); }
    if (/\b(adjust|claim|estimate|supplement|xactimate|scope)/i.test(p.text)) x.s += 1;
    if (PERSONAL.test(email)) x.s -= 3; // homeowners and family write from personal addresses
    score.set(email, x);
  }
  const best = [...score.values()].sort((a, b) => b.s - a.s)[0];
  // Only with real evidence: they write about this claim number, or from the carrier's own domain. Lots of email
  // alone isn't enough (designers, contractors and family email a lot too).
  return best && best.why.size && best.s >= 4 ? { name: best.name || (j.carrier ? `${j.carrier} claims` : ""), email: best.email, why: [...best.why].join(", ") } : null;
}

/** System notices nobody answers: payment receipts, portals, no-reply senders. */
export function isAutomated(from: string, fromName: string, subject: string): boolean {
  return /no-?reply|do-?not-?reply|notifications?@|quickbooks|intuit|docusketch|companycam|mailer-daemon|postmaster/i.test(`${from} ${fromName}`) || /payment received|invoice #|receipt|delivery status notification|out of office|automatic reply/i.test(subject);
}
