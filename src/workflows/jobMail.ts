import { intakeAddress } from "../connectors/homebase/types.js";
import type { Job } from "../core/job.js";
import type { Hub } from "../hub.js";

/**
 * Which job a piece of mail (or a text) belongs to. An address or phone number alone isn't enough when it's on more
 * than one job: the same adjuster, a carrier's shared claims inbox or a property manager shows up on many. So:
 *
 * - Sure signs it's THIS job: its Homebase address (office+<job#>@), its job number, its claim number, or its street.
 * - Sure signs it's ANOTHER job: any of those for a different job. Then it isn't this one, whoever it's from.
 * - A person's address or number counts on its own only when that person is on this job and no other open job.
 *   Shared, it also needs the customer's name or the job's name in the text.
 */
const norm = (s: string) => s.replace(/[\s-]/g, "").toLowerCase();
const email = (s: string) => s.match(/[\w.+-]+@[\w.-]+/)?.[0]?.toLowerCase() ?? "";

export interface JobSigns {
  jobNumber: number;
  intake: string;
  street: string; // "6924 sierra meadows"
  claim: string; // normalized, "" when too short to trust
  names: string[]; // last names and the job's name, lowercased, 4+ letters
  emails: string[];
}

const STREET_END = /\s+(st|street|ave|avenue|ct|court|dr|drive|rd|road|ln|lane|way|blvd|boulevard|cir|circle|pl|place|pkwy|parkway|trl|trail|ter|terrace)\.?$/i;

export function signsOf(j: Job): JobSigns {
  const line = j.address.split(",")[0].trim().toLowerCase();
  // Without the street type, so "6924 Sierra Meadows Dr" and "6924 Sierra Meadows Drive" both match.
  const street = /^\d+\s+\S/.test(line) ? line.replace(STREET_END, "") : "";
  const last = (n: string) => n.trim().split(/\s+/).at(-1)?.toLowerCase() ?? "";
  const names = [...new Set([j.name.toLowerCase().trim(), j.customer.company ? "" : last(j.customer.name), last(j.occupant?.name ?? "")])].filter((n) => n.length >= 4 && !/^(the|and|llc|inc|management|property|properties|group|company|claims?)$/.test(n));
  return {
    jobNumber: j.jobNumber,
    intake: intakeAddress(j.jobNumber).toLowerCase(),
    street: street.length >= 6 ? street : "",
    claim: j.claimNumber && norm(j.claimNumber).length >= 6 ? norm(j.claimNumber) : "",
    names,
    emails: [j.customer.email, j.adjuster.email, j.occupant?.email ?? ""].map((e) => e.toLowerCase()).filter(Boolean),
  };
}

/** Every open job's signs, and which addresses are on more than one of them. */
let memo: { root: string; at: number; v: { signs: Map<number, JobSigns>; shared: Set<string> } } | null = null;
export function allSigns(hub: Hub, fresh = false): { signs: Map<number, JobSigns>; shared: Set<string> } {
  // Worked out once a minute at most (a sync asks for every job in turn).
  if (!fresh && memo && memo.root === hub.cfg.jobsRoot && Date.now() - memo.at < 60_000) return memo.v;
  const v = buildSigns(hub);
  memo = { root: hub.cfg.jobsRoot, at: Date.now(), v };
  return v;
}
function buildSigns(hub: Hub): { signs: Map<number, JobSigns>; shared: Set<string> } {
  const signs = new Map<number, JobSigns>();
  const count = new Map<string, number>();
  for (const j of hub.jobs.list()) {
    const s = signsOf(j);
    signs.set(j.jobNumber, s);
    for (const e of new Set(s.emails)) count.set(e, (count.get(e) ?? 0) + 1);
  }
  // A name only tells jobs apart when one job has it (three "Westward 360" jobs share theirs).
  const nameCount = new Map<string, number>();
  for (const s of signs.values()) for (const n of s.names) nameCount.set(n, (nameCount.get(n) ?? 0) + 1);
  for (const s of signs.values()) s.names = s.names.filter((n) => nameCount.get(n) === 1);
  return { signs, shared: new Set([...count].filter(([, n]) => n > 1).map(([e]) => e)) };
}

/** Does this text carry a sure sign of the job? */
export function sureSign(s: JobSigns, text: string): string {
  const t = text.toLowerCase();
  if (t.includes(s.intake)) return "its Homebase address";
  if (new RegExp(`(#|\\bjob\\s*#?\\s*)${s.jobNumber}\\b`, "i").test(text)) return "its job number";
  if (s.claim && norm(t).includes(s.claim)) return "its claim number";
  if (s.street && t.replace(/\s+/g, " ").includes(s.street)) return "its street";
  return "";
}

/**
 * Whether mail belongs to a job. `text` is everything known about it (subjects, bodies or snippets, and the
 * to/cc/bcc lines); `people` are the addresses on it.
 */
export function belongsToJob(all: { signs: Map<number, JobSigns>; shared: Set<string> }, jobNumber: number, text: string, people: string[]): { belongs: boolean; why: string } {
  const me = all.signs.get(jobNumber);
  if (!me) return { belongs: false, why: "no such job" };
  const mine = sureSign(me, text);
  if (mine) return { belongs: true, why: mine };
  for (const [n, s] of all.signs) {
    if (n === jobNumber) continue;
    const other = sureSign(s, text);
    if (other) return { belongs: false, why: `it's about job #${n} (${other})` };
  }
  const addrs = people.map(email).filter(Boolean);
  const hit = me.emails.filter((e) => addrs.includes(e));
  if (!hit.length) return { belongs: false, why: "nobody on this job is on it" };
  if (hit.some((e) => !all.shared.has(e))) return { belongs: true, why: "from or to someone who's only on this job" };
  // A shared address (same adjuster or company on several jobs): it has to name this job's customer.
  const t = text.toLowerCase();
  const named = me.names.find((n) => new RegExp(`\\b${n.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`).test(t));
  if (named) {
    const others = [...all.signs].filter(([n, s]) => n !== jobNumber && s.names.some((x) => x !== named && new RegExp(`\\b${x.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`).test(t)));
    if (!others.length) return { belongs: true, why: `a shared address, and it names ${named}` };
  }
  return { belongs: false, why: "the address is on several jobs and nothing in it says which" };
}

/** The same test for a search result, which only has the newest message's subject, snippet and address lines. */
export function summaryBelongs(all: { signs: Map<number, JobSigns>; shared: Set<string> }, jobNumber: number, t: { subject: string; snippet?: string; from: string; to?: string; cc?: string }): boolean {
  const people = [t.from, ...(t.to ?? "").split(","), ...(t.cc ?? "").split(",")];
  return belongsToJob(all, jobNumber, `${t.subject}\n${t.snippet ?? ""}\n${t.to ?? ""} ${t.cc ?? ""}`, people).belongs;
}

/** The Gmail search for a job's mail: sure signs, people who are only on this job, and shared people only together with the job's name, street or claim. */
export function jobMailQuery(all: { signs: Map<number, JobSigns>; shared: Set<string> }, jobNumber: number): string {
  const s = all.signs.get(jobNumber);
  if (!s) return "";
  const who = (p: string) => `from:${p} OR to:${p} OR cc:${p}`;
  const own = s.emails.filter((e) => !all.shared.has(e));
  const sharedOnes = s.emails.filter((e) => all.shared.has(e));
  const terms = [s.street ? `"${s.street}"` : "", s.claim ? `"${s.claim}"` : "", ...s.names.map((n) => `"${n}"`)].filter(Boolean);
  const parts = [`"${s.intake}"`, s.street ? `subject:"${s.street}"` : "", ...own.map(who), sharedOnes.length && terms.length ? `((${sharedOnes.map(who).join(" OR ")}) (${terms.join(" OR ")}))` : ""].filter(Boolean);
  return parts.join(" OR ");
}
