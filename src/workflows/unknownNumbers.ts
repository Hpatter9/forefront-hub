import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { TextMessage } from "../connectors/texts/index.js";
import type { Hub } from "../hub.js";
import { addPhoneContact, allContacts, fmtPhone } from "./contacts.js";
import { allSigns, sureSign } from "./jobMail.js";
import { pullJob } from "./pull.js";
import { jobPhones, phoneKey, syncTexts } from "./texts.js";

/**
 * Unknown numbers: people Hunter texts about work who aren't named in Homebase or his contacts, so their texts
 * can't be filed to a job. Keystone looks through the iPhone backup's texts for numbers it doesn't know whose
 * conversation is clearly about work (it names a job, a street on a job, or is full of estimating words), and
 * offers each with a suggested name and job. Naming one ties the number to the job, so the whole conversation
 * files there; skipping one hides it for good. Everything stays on this PC: nothing here is sent to an AI.
 */
export interface UnknownNumber {
  key: string; // the number's last 10 digits
  phone: string; // formatted
  texts: number;
  lastAt: string;
  /** Why it looks like work, in a few words. */
  why: string;
  /** A few lines of the conversation, newest first. */
  sample: { at: string; fromMe: boolean; text: string }[];
  suggestedName: string;
  /** How the name was worked out ("they wrote: this is Heather", "a contact named Heather Hanley"). */
  nameFrom: string;
  suggestedJob?: number;
  jobFrom?: string;
}

interface State {
  skipped: Record<string, string>;
}
const file = (hub: Hub) => path.join(hub.cfg.stateDir, "unknown-numbers.json");
function state(hub: Hub): State {
  try {
    return existsSync(file(hub)) ? { skipped: {}, ...JSON.parse(readFileSync(file(hub), "utf8")) } : { skipped: {} };
  } catch {
    return { skipped: {} };
  }
}
function saveState(hub: Hub, s: State) {
  mkdirSync(hub.cfg.stateDir, { recursive: true });
  writeFileSync(file(hub), JSON.stringify(s, null, 2));
}

const WORK = /\b(estimate|estimating|proposal|agreement|claim|adjuster|insurance|deductible|supplement|xactimate|scope|walk ?through|site visit|drywall|flooring|lvp|carpet|tile|cabinets?|vanity|baseboards?|paint(?:ing)?|texture|demo|mitigation|restoration|reconstruction|water damage|leak|mold|dry ?out|contractor|subcontractor|invoice|deposit|selections?|samples?|permit|inspection|lockbox|homeowner|tenant|property manager|hoa|work order|job ?site|forefront|punch list|change order|schedule[ds]?|crew)\b/gi;
const NOT_A_NAME = new Set(["Hunter", "Sorry", "Sure", "Thanks", "Thank", "Just", "Still", "Here", "Good", "Running", "Going", "Not", "The", "This", "That", "Back", "Home", "Late", "Done", "Free", "Available", "Calling", "Trying", "Checking", "Following", "Sending", "Working", "Driving", "Heading", "Happy", "Okay", "Yes", "Well", "Glad", "Also", "Out", "Off", "Almost", "About", "Ready", "Waiting", "Looking", "Hoping", "Wondering", "Interested", "With", "From", "Forefront"]);

/** A name from how the texts read: "This is Heather Hanley", "Hi Heather,", "- Heather". */
export function nameFromTexts(texts: { fromMe: boolean; text: string }[]): { name: string; from: string } | null {
  const ok = (n: string) => n.split(" ").every((w) => /^[A-Z][a-z'’-]{1,}$/.test(w) && !NOT_A_NAME.has(w));
  const tally = new Map<string, { n: number; from: string }>();
  const add = (name: string, from: string, weight: number) => {
    const n = name.trim();
    if (!ok(n)) return;
    const t = tally.get(n) ?? { n: 0, from };
    t.n += weight;
    tally.set(n, t);
  };
  for (const t of texts) {
    if (!t.fromMe) {
      // They introduce themselves.
      for (const m of t.text.matchAll(/\b(?:[Tt]his is|[Ii]t'?s|[Ii]['’]?m|[Mm]y name is)\s+([A-Z][a-z'’-]+(?:\s[A-Z][a-z'’-]+)?)\b/g)) add(m[1], `they wrote “${m[0]}”`, 3);
      // They sign off: "- Heather" or "Thanks, Heather" at the end.
      const sig = t.text.match(/(?:^|\n|[.!?]\s)(?:[-–—]\s*|(?:Thanks|Thank you|Best|Regards),?\s+)([A-Z][a-z'’-]+(?:\s[A-Z][a-z'’-]+)?)\s*$/);
      if (sig) add(sig[1], `they signed “${sig[1]}”`, 2);
    } else {
      // Hunter greets or thanks them by name.
      for (const m of t.text.matchAll(/\b(?:[Hh]i|[Hh]ey|[Hh]ello|[Tt]hanks|[Tt]hank you|[Mm]orning|[Gg]ood morning|[Gg]ood afternoon),?\s+([A-Z][a-z'’-]+)\b/g)) add(m[1], `you wrote “${m[0]}”`, 2);
    }
  }
  // A full name beats a first name it starts with.
  const best = [...tally.entries()].sort((a, b) => b[1].n - a[1].n || b[0].length - a[0].length)[0];
  if (!best) return null;
  const fuller = [...tally.keys()].find((k) => k !== best[0] && k.startsWith(`${best[0]} `));
  return { name: fuller ?? best[0], from: (fuller ? tally.get(fuller)! : best[1]).from };
}

/** Numbers in the texts that aren't anyone Keystone knows, whose conversation is clearly about work. */
export async function unknownNumbers(hub: Hub, days = 90): Promise<{ connected: boolean; problem?: string; items: UnknownNumber[]; skipped: number }> {
  const st = hub.texts.status();
  if (!st.connected) return { connected: false, problem: st.problem, items: [], skipped: 0 };
  const all = await hub.texts.messages(new Date(Date.now() - days * 864e5));
  const known = new Set<string>([...jobPhones(hub).keys()]);
  const people = allContacts(hub);
  // Someone already in the contacts with a job is known; one without a job still shows (to tie them to a job).
  const contactByPhone = new Map<string, (typeof people)[number]>();
  for (const p of people) for (const ph of p.phones) if (phoneKey(ph.number)) contactByPhone.set(phoneKey(ph.number), p);
  const skipped = state(hub).skipped;
  const byNumber = new Map<string, TextMessage[]>();
  for (const m of all) {
    const k = phoneKey(m.handle);
    if (!k || known.has(k) || skipped[k] || !m.text) continue;
    (byNumber.get(k) ?? byNumber.set(k, []).get(k)!).push(m);
  }
  const signs = allSigns(hub, true).signs;
  const jobs = new Map(hub.jobs.list().map((j) => [j.jobNumber, j]));
  const items: UnknownNumber[] = [];
  for (const [key, msgs] of byNumber) {
    const text = msgs.map((m) => m.text).join("\n");
    // Which jobs does the conversation name?
    const mentions = new Map<number, { n: number; how: string }>();
    for (const [n, s] of signs) {
      const sure = sureSign(s, text);
      const named = s.names.find((nm) => new RegExp(`\\b${nm.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`, "i").test(text));
      if (sure || named) mentions.set(n, { n: (sure ? 3 : 0) + (named ? 2 : 0), how: sure ? `the texts mention ${sure.replace("its ", "the job's ")}` : `the texts mention “${named}”` });
    }
    const words = new Set([...text.matchAll(WORK)].map((m) => m[0].toLowerCase()));
    const hasAddress = /\b\d{2,6}\s+(?:[NSEW]\.?\s+)?[A-Z][a-z]+(?:\s[A-Z][a-z]+)?\s(?:St|Street|Ave|Avenue|Ct|Court|Dr|Drive|Rd|Road|Ln|Lane|Way|Blvd|Cir|Circle|Pl|Place)\b/.test(text);
    // Clearly work: it names a job, or it's full of estimating talk (a single "schedule" isn't enough).
    if (!mentions.size && words.size + (hasAddress ? 1 : 0) < 3) continue;
    const job = [...mentions.entries()].sort((a, b) => b[1].n - a[1].n)[0];
    const contact = contactByPhone.get(key);
    const guessed = nameFromTexts(msgs.map((m) => ({ fromMe: m.fromMe, text: m.text })));
    // A first name that matches exactly one known contact becomes their full name (and their job, if they have one).
    let name = contact?.name || guessed?.name || "";
    let nameFrom = contact?.name ? "already in your contacts, with no job" : guessed?.from ?? "";
    let viaContact: (typeof people)[number] | undefined = contact;
    if (!contact && guessed && !guessed.name.includes(" ")) {
      const same = people.filter((p) => p.name.split(" ")[0]?.toLowerCase() === guessed.name.toLowerCase() && p.name.includes(" "));
      const onNamedJob = same.filter((p) => p.jobs.some((j) => mentions.has(j.jobNumber)));
      const pick = onNamedJob.length === 1 ? onNamedJob[0] : same.length === 1 ? same[0] : undefined;
      if (pick) { name = pick.name; nameFrom = `${guessed.from}; you have a contact named ${pick.name}`; viaContact = pick; }
    }
    const contactJob = viaContact?.jobs.find((j) => jobs.has(j.jobNumber));
    const suggestedJob = job?.[0] ?? contactJob?.jobNumber;
    const sorted = [...msgs].sort((a, b) => b.at.localeCompare(a.at));
    items.push({
      key, phone: fmtPhone(key), texts: msgs.length, lastAt: sorted[0].at,
      why: mentions.size ? [...mentions.values()][0].how : `work words: ${[...words].slice(0, 5).join(", ")}`,
      sample: sorted.slice(0, 4).map((m) => ({ at: m.at, fromMe: m.fromMe, text: m.text.slice(0, 240) })),
      suggestedName: name, nameFrom,
      suggestedJob, jobFrom: job ? job[1].how : contactJob ? `${viaContact!.name} is on that job` : undefined,
    });
  }
  items.sort((a, b) => b.lastAt.localeCompare(a.lastAt));
  return { connected: true, items: items.slice(0, 60), skipped: Object.keys(skipped).length };
}

/** Names a number and (optionally) ties it to a job; its texts are then filed there. */
export async function nameNumber(hub: Hub, o: { key: string; name: string; jobNumber?: number; role?: string }): Promise<{ name: string; filed: number }> {
  // A job that's in Homebase but hasn't been opened here yet gets its folder first.
  if (o.jobNumber && !hub.jobs.exists(o.jobNumber)) await pullJob(hub, o.jobNumber, { quiet: true }).catch(() => null);
  const job = o.jobNumber && hub.jobs.exists(o.jobNumber) ? hub.jobs.get(o.jobNumber) : null;
  if (o.jobNumber && !job) throw new Error(`I couldn't find job #${o.jobNumber} in Homebase.`);
  const p = addPhoneContact(hub, { name: o.name, phone: o.key, jobNumber: job?.jobNumber, jobName: job?.name, role: o.role });
  const before = job ? job.texts.lastAt : "";
  const r = await syncTexts(hub).catch(() => null);
  const filed = job && r ? (hub.jobs.get(job.jobNumber).texts.lastAt !== before || r.jobs.includes(job.jobNumber) ? 1 : 0) : 0;
  // Named without a job: nothing more to ask about this number, so it leaves the list.
  if (!job) skipNumber(hub, phoneKey(o.key));
  if (job) hub.jobs.log(job.jobNumber, `${p.name} (${fmtPhone(o.key)}) added as ${o.role || "a contact"}: their texts now file here`);
  return { name: p.name, filed };
}

export function skipNumber(hub: Hub, key: string, undo = false) {
  const s = state(hub);
  if (undo) delete s.skipped[key];
  else s.skipped[key] = new Date().toISOString();
  saveState(hub, s);
}
