import { applyCarrierRule, isToInsurance, ruleForJob } from "./carriers.js";
import { AsyncLocalStorage } from "node:async_hooks";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { DraftInput, DraftRef } from "../connectors/gmail/types.js";
import type { Hub } from "../hub.js";

/**
 * Drafts Keystone made for Hunter (Claude's replies, Plan my day, the send-off, the Estimator tab), kept apart from
 * the ones he writes himself so they're easy to find: the Gmail tab's "Claude drafts" folder lists them, and in
 * Gmail itself they carry the "Claude drafts" label. A draft drops off the folder once it's sent or deleted.
 */
export const GENERATED_LABEL = "Claude drafts";

export interface GeneratedDraft {
  draftId: string;
  messageId: string;
  threadId?: string;
  to: string[];
  subject: string;
  snippet: string;
  attachments: number;
  jobNumber?: number;
  /** What made it: "Send-off", "Plan my day", "Estimator", "Claude". */
  source: string;
  createdAt: string;
  state?: "draft" | "sent" | "gone";
  sentAt?: string;
  checkedAt?: string;
}

const where = new AsyncLocalStorage<{ source: string; made?: GeneratedDraft[] }>();
/** Runs `fn` with drafts it makes credited to `source` ("Plan my day", ...). `made` collects them as they're made. */
export function withDraftSource<T>(source: string, fn: () => Promise<T>, made?: GeneratedDraft[]): Promise<T> {
  return where.run({ source, made }, fn);
}

const file = (hub: Hub) => path.join(hub.cfg.stateDir, "generated-drafts.json");
export function generatedDrafts(hub: Hub): GeneratedDraft[] {
  try {
    return existsSync(file(hub)) ? JSON.parse(readFileSync(file(hub), "utf8")) : [];
  } catch {
    return [];
  }
}
function save(hub: Hub, list: GeneratedDraft[]) {
  mkdirSync(hub.cfg.stateDir, { recursive: true });
  writeFileSync(file(hub), JSON.stringify(list.slice(-300), null, 2));
}

/** Makes a Gmail draft for Keystone and files it under Claude drafts. Every hub-made draft goes through here. */
/**
 * Tidies the text of an AI-written email before it becomes a draft:
 * - line breaks that arrived as the two characters "\n" become real line breaks;
 * - a greeting to a company ("Hi State Farm,") becomes "Hello," (there was no person's name to use);
 * - a signature the AI typed is dropped, since Gmail adds Hunter's real one.
 */
export function cleanDraftBody(body: string, opts: { companies?: string[] } = {}): string {
  let s = body.replace(/\r/g, "");
  if (/\\n/.test(s)) s = s.replace(/\\r?\\n|\\n/g, "\n").replace(/\\t/g, " ");
  s = s.replace(/[ \t]+\n/g, "\n").replace(/\n{3,}/g, "\n\n").trim();
  // The greeting.
  const m = s.match(/^(hi|hello|hey|dear|good (?:morning|afternoon))[ ,]+([^\n,]{1,60}),/i);
  if (m) {
    const who = m[2].trim();
    const company = /\b(insurance|claims?|mutual|farm|farmers|allstate|usaa|geico|travelers|nationwide|liberty|progressive|management|properties|property|group|team|department|dept|llc|inc|company|co\.|services|adjust(?:er|ing)s?|homeowner|customer|there)\b/i.test(who) || (opts.companies ?? []).some((c) => c && who.toLowerCase() === c.trim().toLowerCase());
    if (company && !/^there$/i.test(who)) s = s.replace(m[0], "Hello,");
  }
  // A typed signature at the end: "-- " and what follows, or a closing followed by Hunter's name block.
  s = s.replace(/\n--\s*\n[\s\S]*$/, "").trim();
  s = s.replace(/\n+(Hunter Patterson)(\n(Estimator|Forefront[^\n]*|hunter@[^\n]*|\(?\d{3}\)?[ .-]?\d{3}[ .-]?\d{4}[^\n]*))*\s*$/i, "").trim();
  return s;
}

/**
 * Deleting a conversation from the mail list. Gmail's "move to Trash" doesn't remove drafts (they stay in Drafts),
 * so any drafts in the conversation are deleted as drafts; the rest of it, if there is any, goes to Trash.
 * A conversation that was only a draft is gone for good, like discarding a draft in Gmail.
 */
export async function deleteThread(hub: Hub, threadId: string): Promise<{ drafts: number; trashed: boolean }> {
  const th = await hub.gmail.getThread(threadId).catch(() => null);
  const isDraft = (m: { labelIds?: string[] }) => !!m.labelIds?.includes("DRAFT");
  let drafts = 0;
  // (A lone draft can be its own "thread" with nothing else to read: its id is tried as the draft's message id.)
  for (const id of th ? th.messages.filter(isDraft).map((m) => m.id) : [threadId]) {
    const draftId = await hub.gmail.draftIdFor?.(id).catch(() => null);
    if (!draftId) continue;
    await hub.gmail.deleteDraft?.(draftId);
    drafts++;
  }
  // (The AI drafts list can hand over the draft's own id.)
  if (!th && !drafts && hub.gmail.deleteDraft) {
    try { await hub.gmail.deleteDraft(threadId); drafts++; } catch { /* not a draft id either */ }
  }
  const others = th ? th.messages.some((m) => !isDraft(m)) : false;
  if (others || !drafts) await hub.gmail.modifyThread?.(threadId, { trash: true });
  return { drafts, trashed: others || !drafts };
}

export async function createGeneratedDraft(hub: Hub, d: DraftInput, meta: { jobNumber?: number; source?: string; /** It's the adjuster's email, even if the address isn't recognisably the carrier's. */ toInsurance?: boolean } = {}): Promise<DraftRef> {
  const job = meta.jobNumber && hub.jobs.exists(meta.jobNumber) ? hub.jobs.get(meta.jobNumber) : null;
  d = { ...d, body: cleanDraftBody(d.body, { companies: [job?.carrier ?? "", job?.customer.company ?? ""] }), subject: d.subject.replace(/\\n/g, " ").trim() };
  // A new email to the job's insurance follows the carrier's rule (its claims address; the subject it files by).
  const adjuster = job?.adjuster.email.trim().toLowerCase() ?? "";
  const anyRule = job ? ruleForJob(hub, job) : null;
  const toInsurance = !!job && ((!!adjuster && d.to.some((a) => a.toLowerCase().includes(adjuster))) || (!!anyRule && isToInsurance(anyRule, job, d.to)));
  const rule = job && !d.threadId ? anyRule : null;
  if (rule && job && (meta.toInsurance || isToInsurance(rule, job, d.to))) {
    const fixed = applyCarrierRule(rule, job, d);
    if (fixed.missing) hub.say(`Heads up: ${fixed.missing}`);
    else if (fixed.subject !== d.subject || fixed.to.join() !== d.to.join()) hub.say(`${rule.carrier} email: sent to ${rule.to} with the claim number as the subject.`);
    d = { ...d, to: fixed.to, cc: fixed.cc, subject: fixed.subject };
  }
  // Anything drafted to insurance (the adjuster or the carrier's inbox, new or a reply) copies the homeowner.
  if (job && (meta.toInsurance || toInsurance)) {
    const owner = job.customer.email.trim();
    const has = (list: string[] | undefined) => (list ?? []).some((a) => a.toLowerCase().includes(owner.toLowerCase()));
    if (owner && !has(d.to) && !has(d.cc)) {
      d = { ...d, cc: [...(d.cc ?? []), owner] };
      hub.say(`Copied ${job.customer.attention || job.customer.name || "the homeowner"} (${owner}) on the email to insurance.`);
    } else if (!owner) hub.say(`Heads up: #${job.jobNumber} has no email for the homeowner in Homebase, so they aren't copied on this email to insurance.`);
  }
  const ref = await hub.gmail.createDraft({ ...d, labels: [GENERATED_LABEL] });
  const list = generatedDrafts(hub);
  list.push({
    draftId: ref.id,
    messageId: ref.messageId,
    threadId: ref.threadId,
    to: d.to,
    subject: d.subject,
    snippet: d.body.replace(/\s+/g, " ").trim().slice(0, 160),
    attachments: d.attachments.length,
    jobNumber: meta.jobNumber,
    source: meta.source ?? where.getStore()?.source ?? "Claude",
    createdAt: new Date().toISOString(),
    state: "draft",
  });
  save(hub, list);
  where.getStore()?.made?.push(list[list.length - 1]);
  return ref;
}

/** Keystone's drafts still waiting in Gmail, newest first (checks whether each is still a draft every few minutes). */
export async function openGeneratedDrafts(hub: Hub): Promise<GeneratedDraft[]> {
  const list = generatedDrafts(hub);
  let changed = false;
  const fresh = Date.now() - 3 * 60_000;
  await Promise.all(
    list
      .filter((g) => g.state === "draft" && (!g.checkedAt || Date.parse(g.checkedAt) < fresh))
      .slice(-60)
      .map(async (g) => {
        const st = await hub.gmail.draftStatus({ id: g.draftId, messageId: g.messageId, threadId: g.threadId }).catch(() => null);
        if (!st) return;
        g.state = st.state;
        if (st.sentAt) g.sentAt = st.sentAt;
        g.checkedAt = new Date().toISOString();
        changed = true;
      }),
  );
  if (changed) save(hub, list);
  return list.filter((g) => g.state === "draft").reverse();
}
