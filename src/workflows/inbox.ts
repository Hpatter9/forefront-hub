import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { intakeAddress } from "../connectors/homebase/types.js";
import type { Message } from "../connectors/gmail/types.js";
import type { Hub } from "../hub.js";
import { isAutomated } from "./reminders.js";
import { noteMessages } from "./contacts.js";

/**
 * Files every incoming job email in Homebase on its own: Keystone forwards it to the job's office+<job#> address, the
 * same mailbox your BCCs go to, and Homebase files it under the original sender and date and keeps its attachments
 * on the job's Documents. The attachments are also saved in the job folder (email/attachments/).
 *
 * It files only when the job is clear: the email names the job number or claim number, or Homebase's suggest door
 * finds exactly one open job for it (sender is a contact on that job, its street, ...). Anything less certain is
 * listed on the Today screen to pick the job by hand. Emails already copied to an office+ address are skipped.
 */
export interface Unfiled {
  messageId: string;
  threadId: string;
  from: string;
  subject: string;
  at: string;
  candidates: { jobNumber: number; name: string }[];
}

interface State {
  filed: Record<string, { jobNumber: number; at: string }>;
  unfiled: Unfiled[];
  since?: string;
}

const FILED_LABEL = "Filed in Homebase";

function stateFile(hub: Hub) {
  return path.join(hub.cfg.stateDir, "inbox.json");
}

export function inboxState(hub: Hub): State {
  const f = stateFile(hub);
  return existsSync(f) ? JSON.parse(readFileSync(f, "utf8")) : { filed: {}, unfiled: [] };
}

function save(hub: Hub, s: State) {
  mkdirSync(hub.cfg.stateDir, { recursive: true });
  writeFileSync(stateFile(hub), JSON.stringify(s, null, 2));
}

const addr = (s: string) => s.match(/[\w.+-]+@[\w.-]+/)?.[0]?.toLowerCase() ?? "";

/** Which job a message is about: a sure match, or the candidates when it isn't sure. */
export async function matchJob(hub: Hub, m: Message): Promise<{ jobNumber?: number; candidates: { jobNumber: number; name: string }[] }> {
  const text = `${m.subject}\n${m.body}`;
  const open = new Map(hub.jobs.list().map((j) => [j.jobNumber, j]));
  // 1. A job number written in the email ("#3226", "job 3226", "3226 - Augustine").
  // (A bare number at the start of a line only counts as "3226 - Augustine": "6924 Sierra Meadows Dr" is an address.)
  for (const x of text.matchAll(/(?:#|\bjob\s*#?\s*)(\d{4})\b|^(\d{4})\s*[-–—]\s*[A-Za-z]/gim)) { const n = Number(x[1] ?? x[2]); if (open.has(n)) return { jobNumber: n, candidates: [] }; }
  // 2. A claim number on exactly one job.
  const norm = (s: string) => s.replace(/[\s-]/g, "").toLowerCase();
  const t = norm(text);
  const byClaim = [...open.values()].filter((j) => j.claimNumber && norm(j.claimNumber).length >= 6 && t.includes(norm(j.claimNumber)));
  if (byClaim.length === 1) return { jobNumber: byClaim[0].jobNumber, candidates: [] };
  // 3. Homebase's own guess from addresses and streets: sure only when it names exactly one open job.
  const addresses = [m.from, ...m.to, ...m.cc].map(addr).filter((a) => a && !a.endsWith("@forefrontteam.com"));
  const streets = [...text.matchAll(/\b\d{2,6}\s+(?:[NSEW]\.?\s+)?[A-Z][a-z]+(?:\s[A-Z][a-z]+)?\s(?:St|Street|Ave|Avenue|Ct|Court|Dr|Drive|Rd|Road|Ln|Lane|Way|Blvd|Cir|Circle|Pl|Place|Pkwy|Trl|Ter)\b/g)].map((x) => x[0]).slice(0, 10);
  const sug = ((await hub.homebase.suggestJobs?.({ addresses, streets }).catch(() => [])) ?? []).filter((j) => open.has(j.jobNumber));
  const candidates = sug.map((j) => ({ jobNumber: j.jobNumber, name: j.name }));
  if (candidates.length === 1) return { jobNumber: candidates[0].jobNumber, candidates: [] };
  // 4. The sender is the customer or adjuster on exactly one job folder.
  const from = addr(m.from);
  const byPerson = [...open.values()].filter((j) => [j.customer.email, j.adjuster.email].map((e) => e.toLowerCase()).includes(from));
  if (byPerson.length === 1) return { jobNumber: byPerson[0].jobNumber, candidates: [] };
  return { candidates: candidates.length ? candidates : byPerson.map((j) => ({ jobNumber: j.jobNumber, name: j.name })) };
}

/**
 * A copy Keystone (or Hunter) forwarded to a job's office+<job#> address just to log it in Homebase: one message,
 * sent only to that address. Those are record-keeping, not conversations, so the Sent list leaves them out.
 * A real email that only BCCs the office address still shows (its To line is a person).
 */
export function isHomebaseLog(t: { to?: string; cc?: string; messageCount: number }): boolean {
  const to = (t.to ?? "").match(/[\w.+-]+@[\w.-]+/g) ?? [];
  return t.messageCount === 1 && to.length > 0 && to.every((a) => /^office\+\d+@/i.test(a)) && !(t.cc ?? "").trim();
}

/** Forwards one message to the job's office+ address with its attachments, and keeps the attachments in the folder. */
export async function fileMessage(hub: Hub, threadId: string, messageId: string, jobNumber: number): Promise<string[]> {
  if (!hub.gmail.send) throw new Error("This Gmail connection can't forward.");
  const t = await hub.gmail.getThread(threadId);
  const m = t.messages.find((x) => x.id === messageId);
  if (!m) throw new Error("That email isn't in the thread any more.");
  const dir = hub.jobs.path(jobNumber, "email", "attachments", `${m.date.slice(0, 10)} ${m.subject.replace(/[<>:"/\\|?*]/g, "").slice(0, 60).trim() || "email"}`);
  const files: string[] = [];
  if (m.attachments.length && hub.gmail.attachment) {
    mkdirSync(dir, { recursive: true });
    for (const a of m.attachments) {
      const f = path.join(dir, a.filename.replace(/[<>:"/\\|?*]/g, "_"));
      if (!existsSync(f)) writeFileSync(f, await hub.gmail.attachment(m.id, a.id));
      files.push(f);
    }
  }
  // Gmail's own forward block: Homebase files a forward under the original sender and date.
  const head = ["---------- Forwarded message ---------", `From: ${m.from}`, `Date: ${new Date(m.date).toUTCString()}`, `Subject: ${m.subject}`, `To: ${m.to.join(", ")}`];
  if (m.cc.length) head.push(`Cc: ${m.cc.join(", ")}`);
  const body = `${head.join("\n")}\n\n${m.body}`;
  await hub.gmail.send({ to: [intakeAddress(jobNumber)], bcc: [], subject: `Fwd: ${m.subject}`, body, attachments: files });
  const label = await hub.gmail.ensureLabel?.(FILED_LABEL).catch(() => undefined);
  if (label) await hub.gmail.modifyThread?.(threadId, { add: [label] }).catch(() => {});
  const s = inboxState(hub);
  s.filed[messageId] = { jobNumber, at: new Date().toISOString() };
  s.unfiled = s.unfiled.filter((u) => u.messageId !== messageId);
  save(hub, s);
  if (hub.jobs.exists(jobNumber)) hub.jobs.log(jobNumber, `Filed email from ${m.from}: ${m.subject}${files.length ? ` (${files.length} attachment${files.length === 1 ? "" : "s"})` : ""}`);
  return files;
}

/** Looks at the last few days of incoming mail and files what it can. Run by the background sync. */
export async function autoFile(hub: Hub): Promise<{ filed: { jobNumber: number; subject: string }[]; unfiled: number }> {
  const out = { filed: [] as { jobNumber: number; subject: string }[], unfiled: 0 };
  if (hub.gmail.kind !== "google" || !hub.gmail.listThreads || !(hub.gmail.fullAccess?.() ?? false)) return out;
  const s = inboxState(hub);
  // Start from when auto-filing was first switched on, so old mail isn't forwarded in bulk.
  s.since ??= new Date().toISOString();
  save(hub, s);
  const me = hub.cfg.gmail.address.toLowerCase();
  const { threads } = await hub.gmail.listThreads({ q: "newer_than:3d -from:me -in:sent -in:chats", max: 40 });
  for (const th of threads) {
    const t = await hub.gmail.getThread(th.id, th.historyId).catch(() => null);
    if (t) noteMessages(hub, t.messages);
    for (const m of t?.messages ?? []) {
      if (s.filed[m.id] || s.unfiled.some((u) => u.messageId === m.id)) continue;
      if (new Date(m.date) < new Date(s.since!)) continue;
      if (addr(m.from) === me || isAutomated(m.from, "", m.subject)) continue;
      if ([...m.to, ...m.cc].some((a) => /office\+\d+@forefrontteam\.com/i.test(a))) {
        s.filed[m.id] = { jobNumber: Number([...m.to, ...m.cc].join(" ").match(/office\+(\d+)@/i)?.[1] ?? 0), at: new Date().toISOString() };
        continue; // Homebase already has it
      }
      const match = await matchJob(hub, m);
      if (match.jobNumber) {
        await fileMessage(hub, th.id, m.id, match.jobNumber);
        out.filed.push({ jobNumber: match.jobNumber, subject: m.subject });
        Object.assign(s, inboxState(hub));
      } else if (match.candidates.length) {
        s.unfiled.push({ messageId: m.id, threadId: th.id, from: m.from, subject: m.subject, at: m.date, candidates: match.candidates.slice(0, 4) });
      }
    }
  }
  save(hub, s);
  out.unfiled = s.unfiled.length;
  return out;
}

export function dismissUnfiled(hub: Hub, messageId: string) {
  const s = inboxState(hub);
  s.unfiled = s.unfiled.filter((u) => u.messageId !== messageId);
  s.filed[messageId] = { jobNumber: 0, at: new Date().toISOString() };
  save(hub, s);
}
