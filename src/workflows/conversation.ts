import { intakeAddress } from "../connectors/homebase/types.js";
import type { Message } from "../connectors/gmail/types.js";
import type { Hub } from "../hub.js";
import { adjusterReview, reminders, stepFor } from "./reminders.js";
import { jobTexts } from "./texts.js";
import { jobWalks } from "./walks.js";

/**
 * A job's whole conversation, in order: every email in the Gmail threads that belong to the job, the texts with its
 * people, calls logged in Homebase and walk recordings. The Gmail tab's "By job" view shows it as one back-and-forth.
 * Each email keeps what a proper reply needs (its thread, Message-ID and References), so answering from here stays
 * in the same thread for everyone on it.
 */
export interface ConvItem {
  kind: "email" | "text" | "call" | "walk";
  id: string;
  at: string;
  fromMe: boolean;
  /** Who it's from (or, for mine, who it went to). */
  who: string;
  body: string;
  // email only
  subject?: string;
  threadId?: string;
  from?: string;
  to?: string[];
  cc?: string[];
  messageIdHeader?: string;
  references?: string;
  attachments?: string[];
  draft?: boolean;
  unread?: boolean;
  /** The full text when `body` was cut down to the new part. */
  full?: string;
}

/** The new part of an email: without the quoted earlier messages underneath. */
export function stripQuoted(body: string): string {
  const lines = body.replace(/\r/g, "").split("\n");
  const cut = lines.findIndex((l, i) => /^On .{6,120}wrote:\s*$/.test(l.trim()) || /^-{2,}\s*(Original|Forwarded) Message\s*-{2,}/i.test(l.trim()) || (/^From:\s/.test(l) && /^(Sent|Date):\s/.test(lines[i + 1] ?? "")) || (/^>/.test(l) && lines.slice(i, i + 3).every((x) => /^>/.test(x) || !x.trim())));
  const kept = (cut >= 0 ? lines.slice(0, cut) : lines).join("\n").trim();
  return kept || body.trim();
}

const addr = (s: string) => s.match(/[\w.+-]+@[\w.-]+/)?.[0]?.toLowerCase() ?? "";
const nameOf = (s: string) => s.replace(/<.*>/, "").replace(/"/g, "").trim() || addr(s);

/** The Gmail threads that belong to a job (the same test the reminders use), newest first. */
async function jobThreads(hub: Hub, n: number): Promise<{ id: string; messages: Message[] }[]> {
  const job = hub.jobs.get(n);
  const people = [job.customer.email, job.adjuster.email, job.occupant?.email ?? ""].filter(Boolean).map((x) => x.toLowerCase());
  const street = job.address.split(",")[0].trim();
  const intake = intakeAddress(n).toLowerCase();
  if (hub.gmail.kind === "google") {
    const q = [...people.map((p) => `from:${p} OR to:${p} OR cc:${p}`), `"${intake}"`, street ? `subject:"${street}"` : ""].filter(Boolean).join(" OR ");
    if (!q) return [];
    const found = await hub.gmail.search(`(${q}) newer_than:120d`, 12).catch(() => []);
    const out = [];
    for (const t of found) out.push(await hub.gmail.getThread(t.id).catch(() => ({ id: t.id, messages: [] as Message[] })));
    return out;
  }
  // The test inbox: look through it and keep what's about this job.
  const all = (await hub.gmail.listThreads?.({}).catch(() => ({ threads: [] })))?.threads ?? [];
  const out = [];
  for (const t of all) {
    const th = await hub.gmail.getThread(t.id).catch(() => null);
    if (!th) continue;
    const text = th.messages.map((m) => `${m.subject} ${m.from} ${m.to.join(" ")} ${m.cc.join(" ")} ${(m.bcc ?? []).join(" ")}`).join(" ").toLowerCase();
    if (people.some((p) => text.includes(p)) || text.includes(intake) || (street.length >= 6 && th.messages.some((m) => m.subject.toLowerCase().includes(street.toLowerCase()))) || new RegExp(`#${n}\\b`).test(text)) out.push(th);
  }
  return out;
}

export async function jobConversation(hub: Hub, n: number): Promise<{ items: ConvItem[]; replyTo: ConvItem | null }> {
  const me = hub.cfg.gmail.address.toLowerCase();
  const items: ConvItem[] = [];
  const seen = new Set<string>();
  for (const th of await jobThreads(hub, n)) {
    for (const m of th.messages) {
      if (seen.has(m.id)) continue;
      seen.add(m.id);
      const fromMe = addr(m.from) === me;
      const body = stripQuoted(m.body ?? "");
      items.push({
        kind: "email", id: m.id, threadId: th.id, at: new Date(m.date).toISOString(), fromMe,
        who: fromMe ? `to ${m.to.map(nameOf).slice(0, 3).join(", ") || "?"}` : nameOf(m.from),
        subject: m.subject, from: m.from, to: m.to, cc: m.cc, body: body.slice(0, 4000), full: body.length < (m.body ?? "").trim().length ? (m.body ?? "").slice(0, 20000) : undefined,
        messageIdHeader: m.messageIdHeader, references: m.references, attachments: m.attachments.map((a) => a.filename),
        draft: m.labelIds?.includes("DRAFT") || undefined, unread: m.labelIds?.includes("UNREAD") || undefined,
      });
    }
  }
  for (const [i, t] of jobTexts(hub, n).entries()) items.push({ kind: "text", id: `text-${i}-${t.at}`, at: t.at, fromMe: t.fromMe, who: t.fromMe ? `to ${t.who}` : t.who, body: t.text });
  for (const a of (await hub.homebase.activity?.(n).catch(() => [])) ?? []) {
    if (!/call/i.test(a.type)) continue;
    items.push({ kind: "call", id: `call-${a.on}-${a.subject}`, at: new Date(a.on).toISOString(), fromMe: a.direction !== "Inbound", who: a.who || "", body: [a.subject, a.details].filter(Boolean).join(": ") });
  }
  for (const w of jobWalks(hub, n)) items.push({ kind: "walk", id: `walk-${w.file}`, at: w.at, fromMe: true, who: "Scope walk recording", body: w.summary });
  items.sort((a, b) => a.at.localeCompare(b.at));
  // What "reply" answers: the newest email from someone else (not a draft, not mine).
  const replyTo = [...items].reverse().find((x) => x.kind === "email" && !x.fromMe && !x.draft) ?? null;
  return { items: items.slice(-120), replyTo };
}

/** The job list for the By job view: who's waiting on a reply first, then the most recently active. */
export function mailJobs(hub: Hub): { jobNumber: number; name: string; stage: string; address: string; waiting: boolean; lastAt: string; last: string; quietDays: number | null; step: string }[] {
  const rem = reminders(hub);
  return hub.jobs
    .list()
    .filter((j) => !["Payment Received", "Closed Lost", "Invoiced"].includes(j.stage))
    .map((j) => {
      const lastAt = [j.pulse.lastTouchAt, j.texts.lastAt].filter(Boolean).sort().at(-1) ?? "";
      return {
        jobNumber: j.jobNumber, name: j.name, stage: j.stage, address: j.address.split(",")[0],
        waiting: rem.some((r) => r.jobNumber === j.jobNumber && r.kind === "reply"),
        lastAt, last: j.texts.lastAt && j.texts.lastAt === lastAt ? j.texts.last : j.pulse.lastTouch,
        quietDays: lastAt ? Math.floor((Date.now() - Date.parse(lastAt)) / 864e5) : null,
        step: adjusterReview(j) && j.stage === "Proposal Submitted" ? stepFor(j.stage) : stepFor(j.stage),
      };
    })
    .sort((a, b) => Number(b.waiting) - Number(a.waiting) || (b.lastAt || "").localeCompare(a.lastAt || ""));
}

/**
 * The References header for a reply: the chain the original carried, plus the original itself. Mail programs use it
 * (with In-Reply-To) to keep a reply in the same conversation.
 */
export function replyReferences(original: { messageIdHeader?: string; references?: string }): string {
  const ids = `${original.references ?? ""} ${original.messageIdHeader ?? ""}`.match(/<[^<>\s]+>/g) ?? [];
  return [...new Set(ids)].slice(-20).join(" ");
}

/** "Re: " once, however many times the subject already has it. */
export const replySubject = (subject: string) => `Re: ${subject.replace(/^(\s*(re|aw|sv)\s*:\s*)+/i, "").trim()}`;
