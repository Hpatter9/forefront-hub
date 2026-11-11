import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { TextMessage } from "../connectors/texts/index.js";
import type { Hub } from "../hub.js";
import { allContacts } from "./contacts.js";
import { allSigns, sureSign } from "./jobMail.js";

/**
 * Texts with the people on Hunter's jobs. Keystone reads the iPhone's backup, keeps ONLY the conversations whose
 * phone number belongs to someone on a job (customer, adjuster, on-site contact, or a contact tied to the job), and
 * drops everything else unread and unsaved: personal texts never leave the backup. What it keeps goes in the job
 * folder (notes/texts.json) for the timeline, and a short summary in job.json for the reminders: a text you sent
 * counts as contact; a text from them with no answer after it is waiting on you.
 */
export interface JobText {
  at: string;
  fromMe: boolean;
  who: string; // the person's name on the job
  role: string;
  text: string;
}

/** A phone number's last 10 digits ("+1 (303) 555-0100" -> "3035550100"); "" when it isn't a phone number. */
export const phoneKey = (s: string) => {
  const d = (s || "").replace(/\D/g, "");
  return d.length >= 10 ? d.slice(-10) : "";
};

/** Everyone with a phone number on a job: number -> the jobs and people it belongs to. */
export function jobPhones(hub: Hub): Map<string, { jobNumber: number; who: string; role: string }[]> {
  const out = new Map<string, { jobNumber: number; who: string; role: string }[]>();
  const add = (phone: string, jobNumber: number, who: string, role: string) => {
    const k = phoneKey(phone);
    if (!k) return;
    const list = out.get(k) ?? out.set(k, []).get(k)!;
    if (!list.some((x) => x.jobNumber === jobNumber)) list.push({ jobNumber, who, role });
  };
  const open = new Set<number>();
  for (const j of hub.jobs.list()) {
    open.add(j.jobNumber);
    add(j.customer.phone, j.jobNumber, j.customer.attention || j.customer.name, "customer");
    add(j.adjuster.phone, j.jobNumber, j.adjuster.name, "adjuster");
    if (j.occupant) add(j.occupant.phone, j.jobNumber, j.occupant.name, "on-site contact");
  }
  for (const p of allContacts(hub)) for (const ph of p.phones) for (const job of p.jobs) if (open.has(job.jobNumber)) add(ph.number, job.jobNumber, p.name, job.role || "contact");
  return out;
}

const file = (hub: Hub, n: number) => hub.jobs.path(n, "notes", "texts.json");
export function jobTexts(hub: Hub, n: number): JobText[] {
  try {
    return existsSync(file(hub, n)) ? JSON.parse(readFileSync(file(hub, n), "utf8")) : [];
  } catch {
    return [];
  }
}

export interface TextsSync {
  connected: boolean;
  problem?: string;
  backupAt?: string;
  read: number;
  matched: number;
  /** Texts with someone who's on several jobs, where nothing said which job. */
  unassigned?: number;
  jobs: number[];
}

/** Reads the last `days` of texts and files the ones that belong to a job. Read-only toward the phone and backup. */
export async function syncTexts(hub: Hub, days = 60): Promise<TextsSync> {
  const st = hub.texts.status();
  if (!st.connected) return { connected: false, problem: st.problem, backupAt: st.backupAt, read: 0, matched: 0, jobs: [] };
  const all = await hub.texts.messages(new Date(Date.now() - days * 864e5));
  const phones = jobPhones(hub);
  const byJob = new Map<number, JobText[]>();
  let matched = 0, unassigned = 0;
  // A number on several jobs (the same adjuster or property manager): a day's texts with them go to the job that
  // day's texts name (street, job number, the customer's name). If nothing says which job, they aren't filed to any.
  const signs = allSigns(hub, true).signs;
  const dayOfText = (iso: string) => new Date(iso).toLocaleDateString("en-CA", { timeZone: "America/Denver" });
  const dayText = new Map<string, string>();
  for (const m of all) {
    const hits = phones.get(phoneKey(m.handle));
    if (hits && hits.length > 1 && m.text) dayText.set(`${phoneKey(m.handle)}|${dayOfText(m.at)}`, `${dayText.get(`${phoneKey(m.handle)}|${dayOfText(m.at)}`) ?? ""}\n${m.text}`);
  }
  const namedIn = (jobNumber: number, text: string) => {
    const s = signs.get(jobNumber);
    if (!s) return false;
    const t = text.toLowerCase();
    return !!sureSign(s, text) || s.names.some((n) => new RegExp(`\\b${n.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`).test(t));
  };
  for (const m of all) {
    let hits = phones.get(phoneKey(m.handle));
    if (!hits || !m.text) continue; // not someone on a job: never kept
    if (hits.length > 1) {
      const text = dayText.get(`${phoneKey(m.handle)}|${dayOfText(m.at)}`) ?? "";
      hits = hits.filter((h) => namedIn(h.jobNumber, text));
      if (!hits.length) { unassigned++; continue; }
    }
    matched++;
    for (const h of hits) (byJob.get(h.jobNumber) ?? byJob.set(h.jobNumber, []).get(h.jobNumber)!).push({ at: m.at, fromMe: m.fromMe, who: h.who, role: h.role, text: m.text });
  }
  for (const j of hub.jobs.list()) {
    const list = (byJob.get(j.jobNumber) ?? []).sort((a, b) => b.at.localeCompare(a.at));
    if (!list.length && !j.texts.lastAt) continue;
    // (Also when it's now empty: texts filed here earlier by a shared number are taken back out.)
    if (list.length || existsSync(file(hub, j.jobNumber))) {
      mkdirSync(path.dirname(file(hub, j.jobNumber)), { recursive: true });
      writeFileSync(file(hub, j.jobNumber), JSON.stringify(list.slice(0, 400), null, 2));
    }
    hub.jobs.upsert(j.jobNumber, { texts: summarize(list, st.backupAt ?? "") });
  }
  return { connected: true, backupAt: st.backupAt, read: all.length, matched, unassigned, jobs: [...byJob.keys()] };
}

/** The job's texting state: the last text either way, your last text, and a text of theirs you haven't answered. */
export function summarize(list: JobText[], backupAt: string) {
  const newest = list[0];
  const mine = list.find((t) => t.fromMe);
  const waiting = newest && !newest.fromMe ? { from: newest.who, text: newest.text.slice(0, 160), at: newest.at } : null;
  return { lastAt: newest?.at ?? "", lastFromMeAt: mine?.at ?? "", last: newest ? `${newest.fromMe ? "you texted" : "text from"} ${newest.who}` : "", waiting, checkedAt: backupAt };
}

// ---------------------------------------------------------------------------------------------------------------
// One summary per day for Homebase (not a line per text)

const dayOf = (iso: string) => new Date(iso).toLocaleDateString("en-CA", { timeZone: "America/Denver" });
const niceDay = (day: string) => new Date(`${day}T12:00:00`).toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric" });

/** A job's texts by day and person, newest day first: one conversation per person per day. */
export function textDays(hub: Hub, n: number): { day: string; who: string; role: string; texts: JobText[] }[] {
  const groups = new Map<string, { day: string; who: string; role: string; texts: JobText[] }>();
  for (const t of jobTexts(hub, n)) {
    const k = `${dayOf(t.at)}|${t.who}`;
    (groups.get(k) ?? groups.set(k, { day: dayOf(t.at), who: t.who, role: t.role, texts: [] }).get(k)!).texts.push(t);
  }
  return [...groups.values()].map((g) => ({ ...g, texts: g.texts.sort((a, b) => a.at.localeCompare(b.at)) })).sort((a, b) => b.day.localeCompare(a.day));
}

interface TextLog {
  [key: string]: { summary: string; loggedAt?: string; declinedAt?: string };
}
const logFile = (hub: Hub, n: number) => hub.jobs.path(n, "notes", "texts-log.json");
export function textLog(hub: Hub, n: number): TextLog {
  try {
    return existsSync(logFile(hub, n)) ? JSON.parse(readFileSync(logFile(hub, n), "utf8")) : {};
  } catch {
    return {};
  }
}

/** How far back a day's texts still get offered to Homebase (so turning texts on doesn't offer two months at once). */
export const TEXT_LOG_DAYS = 3;

/** Finished days (before today) of texting that haven't been summarized for Homebase yet. */
export function pendingTextDays(hub: Hub): { jobNumber: number; name: string; day: string; who: string; role: string; texts: JobText[] }[] {
  const today = dayOf(new Date().toISOString());
  const oldest = dayOf(new Date(Date.now() - TEXT_LOG_DAYS * 864e5).toISOString());
  const out = [];
  for (const j of hub.jobs.list()) {
    if (!j.texts.lastAt) continue;
    const log = textLog(hub, j.jobNumber);
    for (const g of textDays(hub, j.jobNumber)) if (g.day < today && g.day >= oldest && !log[`${g.day}|${g.who}`]) out.push({ jobNumber: j.jobNumber, name: j.name, ...g });
  }
  return out;
}

/**
 * Writes one short summary of each finished day's text conversation and, with Hunter's OK (one card for all of
 * them), posts each as a note on its job in Homebase. A day that's been offered isn't offered again.
 */
export async function logTextDays(hub: Hub, summarize: (p: { jobNumber: number; name: string; day: string; who: string; role: string; texts: JobText[] }) => Promise<string>): Promise<number> {
  const pending = pendingTextDays(hub);
  if (!pending.length) return 0;
  const notes: { p: (typeof pending)[number]; body: string }[] = [];
  for (const p of pending) {
    let summary = "";
    try {
      summary = (await summarize(p)).trim();
    } catch {
      summary = "";
    }
    // Without the AI: a plain count, so the contact is still on record.
    if (!summary) summary = `${p.texts.length} text${p.texts.length === 1 ? "" : "s"} back and forth.`;
    notes.push({ p, body: `Texts with ${p.who} (${p.role}), ${niceDay(p.day)}: ${summary}` });
  }
  const yes = await hub.approver.confirm(`Add ${notes.length === 1 ? "this text summary" : `these ${notes.length} text summaries`} to Homebase?`, notes.map((x) => `#${x.p.jobNumber} ${x.p.name}: ${x.body}`));
  let posted = 0;
  for (const { p, body } of notes) {
    const log = textLog(hub, p.jobNumber);
    const key = `${p.day}|${p.who}`;
    if (yes) {
      try {
        await hub.homebase.addNote(p.jobNumber, { kind: "note", body });
        log[key] = { summary: body, loggedAt: new Date().toISOString() };
        hub.jobs.log(p.jobNumber, `Homebase note: ${body}`);
        posted++;
      } catch (e) {
        hub.say(`Couldn't add the text summary to Homebase #${p.jobNumber}: ${(e as Error).message}`);
        continue; // offered again next time
      }
    } else log[key] = { summary: body, declinedAt: new Date().toISOString() };
    mkdirSync(path.dirname(logFile(hub, p.jobNumber)), { recursive: true });
    writeFileSync(logFile(hub, p.jobNumber), JSON.stringify(log, null, 2));
  }
  if (posted) hub.say(`Added ${posted} text summar${posted === 1 ? "y" : "ies"} to Homebase.`);
  return posted;
}
