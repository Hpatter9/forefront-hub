import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { TextMessage } from "../connectors/texts/index.js";
import type { Hub } from "../hub.js";
import { allContacts } from "./contacts.js";

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
  jobs: number[];
}

/** Reads the last `days` of texts and files the ones that belong to a job. Read-only toward the phone and backup. */
export async function syncTexts(hub: Hub, days = 60): Promise<TextsSync> {
  const st = hub.texts.status();
  if (!st.connected) return { connected: false, problem: st.problem, backupAt: st.backupAt, read: 0, matched: 0, jobs: [] };
  const all = await hub.texts.messages(new Date(Date.now() - days * 864e5));
  const phones = jobPhones(hub);
  const byJob = new Map<number, JobText[]>();
  let matched = 0;
  for (const m of all) {
    const hits = phones.get(phoneKey(m.handle));
    if (!hits || !m.text) continue; // not someone on a job: never kept
    matched++;
    for (const h of hits) (byJob.get(h.jobNumber) ?? byJob.set(h.jobNumber, []).get(h.jobNumber)!).push({ at: m.at, fromMe: m.fromMe, who: h.who, role: h.role, text: m.text });
  }
  for (const j of hub.jobs.list()) {
    const list = (byJob.get(j.jobNumber) ?? []).sort((a, b) => b.at.localeCompare(a.at));
    if (!list.length && !j.texts.lastAt) continue;
    if (list.length) {
      mkdirSync(path.dirname(file(hub, j.jobNumber)), { recursive: true });
      writeFileSync(file(hub, j.jobNumber), JSON.stringify(list.slice(0, 400), null, 2));
    }
    hub.jobs.upsert(j.jobNumber, { texts: summarize(list, st.backupAt ?? "") });
  }
  return { connected: true, backupAt: st.backupAt, read: all.length, matched, jobs: [...byJob.keys()] };
}

/** The job's texting state: the last text either way, your last text, and a text of theirs you haven't answered. */
export function summarize(list: JobText[], backupAt: string) {
  const newest = list[0];
  const mine = list.find((t) => t.fromMe);
  const waiting = newest && !newest.fromMe ? { from: newest.who, text: newest.text.slice(0, 160), at: newest.at } : null;
  return { lastAt: newest?.at ?? "", lastFromMeAt: mine?.at ?? "", last: newest ? `${newest.fromMe ? "you texted" : "text from"} ${newest.who}` : "", waiting, checkedAt: backupAt };
}
