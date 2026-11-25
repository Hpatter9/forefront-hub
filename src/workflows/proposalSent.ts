import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { Message, ThreadSummary } from "../connectors/gmail/types.js";
import { confirmOrReply } from "../core/approval.js";
import { AT_OR_PAST_PROPOSAL } from "../core/job.js";
import type { Hub } from "../hub.js";
import { allSigns, jobOfMail } from "./jobMail.js";
import { estimateFiles } from "./sendoff.js";
import { toLocalDate } from "./sync.js";

/**
 * "I sent the estimate, so the job is at Proposal Submitted." However the email went out (Keystone's compose box, an
 * AI draft Hunter sent, Gmail itself, his phone), Keystone finds it in Sent mail: an email from him, to anyone but
 * the office logging copy (the customer, the adjuster, or a coworker for their customer), on a job, with an estimate
 * / proposal / agreement PDF attached (or an email about one, with a PDF). It then asks once, on a card,
 * and on Yes writes the proposal amount and date to Homebase (always together) and moves the job to Proposal
 * Submitted if it's earlier in the pipeline. A job already at Proposal Submitted only gets its amount brought up to
 * date (a revised estimate); a job past it is left alone.
 */
const PROPOSAL_SUBMITTED = "Proposal Submitted";
/** PDFs that are the proposal itself (a photo report or a work order alone isn't one). */
export const isProposalFile = (name: string) => /\.pdf$/i.test(name) && /(estimate|proposal|agreement|xactimate|\bbid\b|quote)/i.test(name) && !/(photo report|work order|invoice)/i.test(name);

interface State {
  /** Sent emails already dealt with (asked about, or nothing to do), by Gmail message id. */
  handled: Record<string, { job: number; at: string; result: string }>;
  /** Threads looked through, with the version looked at, so an unchanged thread isn't fetched again. */
  threads: Record<string, string>;
}
const file = (hub: Hub) => path.join(hub.cfg.stateDir, "proposals-sent.json");
function load(hub: Hub): State {
  try { if (existsSync(file(hub))) return { handled: {}, threads: {}, ...JSON.parse(readFileSync(file(hub), "utf8")) }; } catch { /* start fresh */ }
  return { handled: {}, threads: {} };
}
function save(hub: Hub, s: State) {
  mkdirSync(hub.cfg.stateDir, { recursive: true });
  // Sent mail is only searched two weeks back, so older entries can go.
  const cut = Date.now() - 60 * 86_400_000;
  for (const [k, v] of Object.entries(s.handled)) if (Date.parse(v.at) < cut) delete s.handled[k];
  if (Object.keys(s.threads).length > 600) s.threads = Object.fromEntries(Object.entries(s.threads).slice(-300));
  writeFileSync(file(hub), JSON.stringify(s, null, 1));
}

export interface SentProposal { jobNumber: number; messageId: string; header?: string; sentAt: string; to: string[]; subject: string; files: string[] }
export interface ProposalResult { jobNumber: number; messageId: string; result: "updated" | "already" | "skipped" | "past" | "no-amount" | "sendoff" | "error"; amount?: number; note?: string }

const addr = (s: string) => s.match(/[\w.+-]+@[\w.-]+/)?.[0]?.toLowerCase() ?? "";
const usd = (n: number) => `$${n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
/** "$7,188.14", "7188.14", "7,188" typed on the card. */
export function typedAmount(reply: string | undefined): number | undefined {
  const m = String(reply ?? "").match(/\$?\s*(\d{1,3}(?:,\d{3})+|\d+)(\.\d{1,2})?/);
  if (!m) return undefined;
  const n = Number((m[1] + (m[2] ?? "")).replace(/,/g, ""));
  return n > 0 ? n : undefined;
}

/** Estimates Hunter has sent lately that haven't been dealt with: the newest one per job. */
export async function sentProposals(hub: Hub, state = load(hub), only?: number): Promise<{ found: SentProposal[]; looked: [string, string][] }> {
  const me = hub.cfg.gmail.address.toLowerCase();
  const domain = me.split("@")[1] ?? "";
  let list: ThreadSummary[] = [];
  if (hub.gmail.kind === "google") list = await hub.gmail.search("in:sent has:attachment filename:pdf newer_than:14d", 60);
  else list = (await hub.gmail.listThreads?.({ label: "SENT" }).catch(() => ({ threads: [] })))?.threads ?? [];
  const all = allSigns(hub);
  const best = new Map<number, SentProposal>();
  const looked: [string, string][] = [];
  for (const t of list) {
    const version = t.historyId ?? `${t.messageCount}:${t.date}`;
    if (only === undefined && state.threads[t.id] === version) continue;
    const th = await hub.gmail.getThread(t.id, t.historyId).catch(() => null);
    if (!th) continue;
    looked.push([t.id, version]);
    const text = th.messages.map((m) => `${m.subject}\n${m.body}\n${m.to.join(" ")} ${m.cc.join(" ")} ${(m.bcc ?? []).join(" ")}`).join("\n");
    const people = th.messages.flatMap((m) => [m.from, ...m.to, ...m.cc]);
    for (const m of th.messages) {
      if (state.handled[m.id] || !isSentProposal(m, me, domain)) continue;
      // The email's own office+<job#> Bcc settles which job; otherwise the conversation has to point at one job only.
      const own = [...`${m.to.join(" ")} ${m.cc.join(" ")} ${(m.bcc ?? []).join(" ")}`.matchAll(/office\+(\d{3,6})@/gi)].map((x) => Number(x[1])).filter((n) => hub.jobs.exists(n));
      const n = own.length === 1 ? own[0] : jobOfMail(all, text, people);
      if (!n || !hub.jobs.exists(n) || (only !== undefined && n !== only)) continue;
      const sentAt = isNaN(Date.parse(m.date)) ? new Date().toISOString() : new Date(m.date).toISOString();
      const p: SentProposal = { jobNumber: n, messageId: m.id, header: m.messageIdHeader, sentAt, to: [...m.to, ...m.cc].filter((a) => !/^office\+\d+@/i.test(addr(a))), subject: m.subject, files: m.attachments.map((a) => a.filename).filter(isProposalFile) };
      const prior = best.get(n);
      if (!prior || prior.sentAt < p.sentAt) best.set(n, p);
    }
  }
  return { found: [...best.values()], looked };
}

function isSentProposal(m: Message, me: string, _domain: string): boolean {
  if (addr(m.from) !== me || m.labelIds?.includes("DRAFT")) return false;
  const pdfs = m.attachments.map((a) => a.filename).filter((f) => /\.pdf$/i.test(f));
  // The PDF is called an estimate / proposal / agreement, or the email is about one and carries a PDF that isn't a
  // photo report, ITEL report or invoice (Xactimate exports have names like "YOUNG-COSPRINGS-RC.pdf").
  const named = pdfs.some(isProposalFile);
  const about = /estimate|proposal|agreement|\bbid\b|\bquote\b/i.test(m.subject) && !/^(fwd?|fw):/i.test(m.subject.trim()) && pdfs.some((f) => !/photo|itel|invoice|work order|report/i.test(f));
  if (!named && !about) return false;
  // Sent to (or for) the customer: someone besides the office copy that only logs it in Homebase. A coworker counts
  // (an estimate sent to Kari or Jen for their customer); the card lets Hunter say no to one that was only a review.
  return [...m.to, ...m.cc].map(addr).some((a) => a && a !== me && !/^office(\+\d+)?@/i.test(a));
}

/** What the estimate on file adds up to (the skill's own math), falling back to what the job folder remembers. */
async function estimateAmount(hub: Hub, n: number): Promise<number | undefined> {
  const job = hub.jobs.get(n);
  const f = estimateFiles(hub, n);
  if (f.estimateJson) {
    try {
      const base = (await hub.skill.totals(f.estimateJson)).find((s) => s.title === "Base Scope");
      if (base?.customerTotal) return base.customerTotal;
    } catch { /* fall back */ }
  }
  return job.estimate.total ?? job.sendoff.proposalAmount;
}

let running = false;
/**
 * Looks for estimates that went out and, for each job that needs it, asks to bring Homebase up to date. One run at a
 * time: a card left unanswered doesn't get a twin from the next check.
 */
export async function checkProposalsSent(hub: Hub, only?: number): Promise<ProposalResult[]> {
  if (running) return [];
  running = true;
  const out: ProposalResult[] = [];
  try {
    const state = load(hub);
    const { found, looked } = await sentProposals(hub, state, only);
    const done = (p: SentProposal, result: ProposalResult["result"], extra: Partial<ProposalResult> = {}) => {
      if (result !== "error" && result !== "sendoff") state.handled[p.messageId] = { job: p.jobNumber, at: new Date().toISOString(), result };
      out.push({ jobNumber: p.jobNumber, messageId: p.messageId, result, ...extra });
    };
    let failed = false;
    for (const p of found) {
      try {
        const job = hub.jobs.get(p.jobNumber);
        // A send-off Keystone drafted itself is logged by `sync`, with the amount it was drafted for.
        if (!job.sendoff.homebaseLoggedAt && job.sendoff.drafts.some((d) => !!p.header && d.messageId === p.header)) { done(p, "sendoff"); failed = true; continue; }
        const hb = await hub.homebase.getJob(p.jobNumber);
        if (AT_OR_PAST_PROPOSAL.has(hb.stage) && hb.stage !== PROPOSAL_SUBMITTED) { done(p, "past"); continue; }
        let amount = await estimateAmount(hub, p.jobNumber);
        const needStage = hb.stage !== PROPOSAL_SUBMITTED;
        const same = amount !== undefined && hb.proposalAmount !== undefined && Math.abs(hb.proposalAmount - amount) < 0.005;
        const needProposal = !(same && hb.proposalSubmittedAt);
        if (!needStage && (!needProposal || amount === undefined)) { done(p, "already"); continue; }
        const date = toLocalDate(p.sentAt), today = toLocalDate(new Date().toISOString());
        const details = [
          `You sent ${p.files.join(", ")} to ${p.to.map((a) => a.replace(/<.*>/, "").replace(/"/g, "").trim() || addr(a)).slice(0, 4).join(", ")} on ${date}.`,
          amount !== undefined
            ? `Proposal amount ${usd(amount)} (Homebase now: ${hb.proposalAmount !== undefined ? usd(hb.proposalAmount) : "blank"}), submitted ${date}. This starts the Day 2/5/10/21 follow-ups.`
            : `Keystone doesn't know this estimate's total. Type the amount you sent in the box (for example 7188.14) and it will be saved with the date ${date}.`,
          hub.homebase.kind === "api" && date !== today && needProposal ? `Note: Homebase records today's date (${today}) for the proposal; it can't be backdated.` : "",
          needStage ? `Stage ${hb.stage || "?"} -> ${PROPOSAL_SUBMITTED}` : `Stage stays ${hb.stage}`,
          amount !== undefined ? "If that's not the number you sent, type the right amount in the box." : "",
        ].filter(Boolean);
        const ans = await confirmOrReply(hub.approver, `Estimate sent for #${p.jobNumber} ${job.name}. Update Homebase?`, details);
        const typed = typedAmount(ans.reply);
        if (typed !== undefined) amount = typed;
        if (!(ans.yes || typed !== undefined)) { done(p, "skipped"); continue; }
        if (amount === undefined) { done(p, "no-amount", { note: "No amount, so the proposal wasn't written." }); hub.say(`#${p.jobNumber}: no proposal amount, so Homebase wasn't changed. Say "set the proposal for #${p.jobNumber} to $..." when you have it.`); continue; }
        if (needProposal || typed !== undefined) await hub.homebase.setProposal(p.jobNumber, { amount, submittedAt: date });
        if (needStage) await hub.homebase.setStage(p.jobNumber, PROPOSAL_SUBMITTED, hb.stage);
        const latest = hub.jobs.get(p.jobNumber);
        hub.jobs.upsert(p.jobNumber, {
          stage: needStage ? PROPOSAL_SUBMITTED : latest.stage,
          estimate: { ...latest.estimate, status: "sent" },
          sendoff: { ...latest.sendoff, proposalAmount: amount, sentAt: p.sentAt, homebaseLoggedAt: new Date().toISOString() },
        });
        hub.jobs.log(p.jobNumber, `Homebase: proposal ${usd(amount)} on ${date}${needStage ? `, stage -> ${PROPOSAL_SUBMITTED}` : ""}`);
        hub.say(`#${p.jobNumber} ${job.name}: Homebase now shows the proposal at ${usd(amount)}${needStage ? ` and the job is at ${PROPOSAL_SUBMITTED}` : ""}.`);
        done(p, "updated", { amount });
      } catch (e) {
        failed = true;
        done(p, "error", { note: (e as Error).message });
        hub.say(`#${p.jobNumber}: couldn't update Homebase after the estimate was sent (${(e as Error).message}). Keystone will try again.`);
      }
    }
    // A thread is only marked as looked at when everything in it was dealt with; otherwise it's read again next time.
    if (!failed) for (const [id, v] of looked) state.threads[id] = v;
    save(hub, state);
  } finally {
    running = false;
  }
  return out;
}
