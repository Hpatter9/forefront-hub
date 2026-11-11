import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { Contact, HbPerson } from "../connectors/homebase/types.js";
import type { Message } from "../connectors/gmail/types.js";
import type { Hub } from "../hub.js";
import { isAutomated } from "./reminders.js";

/**
 * Hunter's contacts, built up on their own: every person who shows up on an email Keystone reads (from, to, cc), the
 * people on each job in Homebase (with their role on the job), and Homebase's own contact records when he looks
 * someone up. Each person fills out as more turns up: phones from email signatures, title and company from
 * Homebase, the jobs they're on, when they last emailed. Kept in .hub/contacts.json.
 */
export interface Person {
  id: string; // the first email seen, lowercased, or "hb:<Homebase id>" when there's no email
  name: string;
  emails: string[];
  phones: { number: string; label?: string; from: "homebase" | "email" | "job" | "you" }[];
  title?: string;
  company?: string;
  homebaseId?: string;
  jobs: { jobNumber: number; name: string; role: string }[];
  emailCount: number;
  firstSeen: string;
  lastSeen: string;
  lastEmailAt?: string;
}

interface Store {
  people: Record<string, Person>;
}

const file = (hub: Hub) => path.join(hub.cfg.stateDir, "contacts.json");
let cache: { dir: string; s: Store } | null = null;
let dirty: NodeJS.Timeout | null = null;

function load(hub: Hub): Store {
  if (cache?.dir === hub.cfg.stateDir) return cache.s;
  let s: Store = { people: {} };
  try {
    if (existsSync(file(hub))) s = JSON.parse(readFileSync(file(hub), "utf8"));
  } catch {
    // start over
  }
  cache = { dir: hub.cfg.stateDir, s };
  mergeDuplicates(s);
  return s;
}

const NOT_ONE_PERSON = /\b(service|support|claims?|team|office|billing|accounts?|info|admin|department|dept|desk|sales|dispatch|scheduling|reception)\b/i;
const normName = (n: string) => n.toLowerCase().replace(/[^a-z\s'-]/g, "").replace(/\s+/g, " ").trim();
/** Two names that can be the same person: equal, or one is just the other's first name, or one is missing. */
function namesAgree(a: string, b: string) {
  const x = normName(a), y = normName(b);
  if (!x || !y || x === y) return true;
  const [xf, yf] = [x.split(" ")[0], y.split(" ")[0]];
  return xf === yf && (!x.includes(" ") || !y.includes(" "));
}
function absorb(into: Person, other: Person) {
  const n = other.name;
  if (n && (!into.name || (n.split(" ").length > into.name.split(" ").length && n.length > into.name.length))) into.name = n;
  for (const e of other.emails) if (!into.emails.includes(e)) into.emails.push(e);
  for (const ph of other.phones) addPhone(into, ph.number, ph.from, ph.label);
  for (const j of other.jobs) {
    const have = into.jobs.find((x) => x.jobNumber === j.jobNumber);
    if (!have) into.jobs.push(j);
    else if (have.role === "Contact" && j.role !== "Contact") have.role = j.role;
  }
  into.title ||= other.title;
  into.company ||= other.company;
  into.homebaseId ||= other.homebaseId;
  into.emailCount += other.emailCount;
  if (other.firstSeen < into.firstSeen) into.firstSeen = other.firstSeen;
  if (other.lastSeen > into.lastSeen) into.lastSeen = other.lastSeen;
  if (other.lastEmailAt && (!into.lastEmailAt || other.lastEmailAt > into.lastEmailAt)) into.lastEmailAt = other.lastEmailAt;
}
/**
 * One person, one card. Two entries are the same person when they share an email address or a Homebase record,
 * share a phone number and their names agree (an office line shared by two differently named people doesn't
 * count), or have the same full name (unless Homebase holds them as two separate people, or the "name" is a
 * shared mailbox like "Claims Team"). The entry with the most behind it is kept and the other folds into it.
 * Returns how many were folded in.
 */
export function mergeDuplicates(s: Store): number {
  let merged = 0;
  for (let pass = 0; pass < 4; pass++) {
    let changed = false;
    const seen = new Map<string, Person>();
    // Email and Homebase entries first, so a number-only or name-only entry folds into the fuller one.
    const rank = (p: Person) => (p.homebaseId ? 0 : p.emails.length ? 1 : 2);
    for (const p of Object.values(s.people).sort((a, b) => rank(a) - rank(b) || a.firstSeen.localeCompare(b.firstSeen))) {
      const full = normName(p.name);
      const keys: { k: string; ok: (q: Person) => boolean }[] = [
        ...p.emails.map((e) => ({ k: `e:${e}`, ok: () => true })),
        ...(p.homebaseId ? [{ k: `h:${p.homebaseId}`, ok: () => true }] : []),
        ...p.phones.map((ph) => ({ k: `p:${digits(ph.number)}`, ok: (q: Person) => namesAgree(p.name, q.name) && !(p.homebaseId && q.homebaseId && p.homebaseId !== q.homebaseId) })),
        ...(full.includes(" ") && !NOT_ONE_PERSON.test(full) ? [{ k: `n:${full}`, ok: (q: Person) => !(p.homebaseId && q.homebaseId && p.homebaseId !== q.homebaseId) }] : []),
      ];
      const hit = keys.map((x) => ({ q: seen.get(x.k), ok: x.ok })).find((x) => x.q && x.q !== p && x.ok(x.q));
      if (hit?.q) {
        absorb(hit.q, p);
        delete s.people[p.id];
        merged++;
        changed = true;
        continue;
      }
      for (const x of keys) if (!seen.has(x.k)) seen.set(x.k, p);
    }
    if (!changed) break;
  }
  return merged;
}
function save(hub: Hub, now = false) {
  mergeDuplicates(load(hub));
  const write = () => {
    mkdirSync(hub.cfg.stateDir, { recursive: true });
    writeFileSync(file(hub), JSON.stringify(load(hub), null, 1));
    dirty = null;
  };
  if (now) return write();
  if (!dirty) {
    dirty = setTimeout(write, 1500);
    dirty.unref?.();
  }
}
export function flushContacts(hub: Hub) {
  if (dirty) clearTimeout(dirty);
  save(hub, true);
}

const addr = (s: string) => s.match(/[\w.+-]+@[\w.-]+\.\w+/)?.[0]?.toLowerCase() ?? "";
const nameOf = (s: string) => s.replace(/<.*>/, "").replace(/["']/g, "").trim();
const digits = (p: string) => p.replace(/\D/g, "").replace(/^1(?=\d{10}$)/, "");
export const fmtPhone = (p: string) => {
  const d = digits(p);
  return d.length === 10 ? `(${d.slice(0, 3)}) ${d.slice(3, 6)}-${d.slice(6)}` : p.trim();
};
const titleCase = (n: string) => (n === n.toUpperCase() || n === n.toLowerCase() ? n.toLowerCase().replace(/\b\w/g, (c) => c.toUpperCase()) : n);
/** "Doe, Jane" -> "Jane Doe". */
const cleanName = (n: string) => {
  const s = nameOf(n);
  if (!s || s.includes("@")) return "";
  const m = s.match(/^([^,]+),\s*([^,]+)$/);
  return titleCase(m ? `${m[2]} ${m[1]}` : s);
};

/** Addresses that aren't people worth keeping: Hunter himself, Homebase's office+ boxes, no-reply senders. */
function skip(hub: Hub, email: string, display = "") {
  const me = hub.cfg.gmail.address.toLowerCase();
  return !email || email === me || /^office\+\d+@/i.test(email) || isAutomated(display ? `${display} <${email}>` : email, "", "");
}

function find(s: Store, o: { email?: string; homebaseId?: string }): Person | undefined {
  if (o.email) {
    const e = o.email.toLowerCase();
    const hit = s.people[e] ?? Object.values(s.people).find((p) => p.emails.includes(e));
    if (hit) return hit;
  }
  if (o.homebaseId) return Object.values(s.people).find((p) => p.homebaseId === o.homebaseId);
  return undefined;
}

function upsert(hub: Hub, o: { email?: string; name?: string; homebaseId?: string; at?: string }): Person | null {
  const s = load(hub);
  const email = o.email?.toLowerCase();
  if (!email && !o.homebaseId) return null;
  const now = o.at ?? new Date().toISOString();
  let p = find(s, { email, homebaseId: o.homebaseId });
  if (!p) {
    p = { id: email ?? `hb:${o.homebaseId}`, name: "", emails: [], phones: [], jobs: [], emailCount: 0, firstSeen: now, lastSeen: now };
    s.people[p.id] = p;
  }
  if (email && !p.emails.includes(email)) p.emails.push(email);
  const n = o.name ? cleanName(o.name) : "";
  // Keep the fullest name seen (a real name beats "jsmith" and one-word names).
  if (n && (!p.name || (n.split(" ").length > p.name.split(" ").length && n.length > p.name.length))) p.name = n;
  if (o.homebaseId) p.homebaseId = o.homebaseId;
  if (now > p.lastSeen) p.lastSeen = now;
  return p;
}

function addPhone(p: Person, number: string, from: Person["phones"][number]["from"], label?: string) {
  const d = digits(number);
  if (d.length < 10 || /^0+$/.test(d)) return;
  const have = p.phones.find((x) => digits(x.number) === d);
  if (have) {
    if (label && !have.label) have.label = label;
    if (from === "homebase") have.from = "homebase";
    return;
  }
  p.phones.push({ number: fmtPhone(number), label, from });
}

/** Everyone on these emails. The sender's signature is read for a phone number. */
export function noteMessages(hub: Hub, messages: Message[]) {
  for (const m of messages) {
    const people = [m.from, ...m.to, ...m.cc, ...(m.bcc ?? [])];
    for (const x of people) {
      const e = addr(x);
      if (skip(hub, e, nameOf(x))) continue;
      const p = upsert(hub, { email: e, name: nameOf(x), at: m.date || undefined });
      if (p && x === m.from) {
        p.emailCount++;
        if (!p.lastEmailAt || m.date > p.lastEmailAt) p.lastEmailAt = m.date;
        for (const ph of signaturePhones(m.body)) addPhone(p, ph.number, "email", ph.label);
      }
    }
  }
  save(hub);
}

/** Just the senders and recipients of a list of threads (no bodies). */
export function noteAddresses(hub: Hub, list: { from: string; at?: string }[]) {
  for (const x of list) {
    for (const part of x.from.split(/,(?![^<]*>)/)) {
      const e = addr(part);
      if (!skip(hub, e, nameOf(part))) upsert(hub, { email: e, name: nameOf(part), at: x.at });
    }
  }
  save(hub);
}

/** Phone numbers in an email's signature (the last lines before any quoted reply). */
export function signaturePhones(body: string): { number: string; label?: string }[] {
  const main = String(body ?? "").replace(/\r/g, "").split(/\n(?:On .+wrote:|-{2,}\s*(?:Original|Forwarded) Message|From: .+\n(?:Sent|Date):)/)[0];
  const tail = main.split("\n").slice(-15).join("\n");
  const out: { number: string; label?: string }[] = [];
  // "O: (720) 555-0199 | F: 720-555-0100": each part of a line gets its own label, so a fax is left out.
  for (const line of tail.split(/\n|\s[|•·]\s|\s{3,}|\t/)) {
    for (const m of line.matchAll(/(?:\+?1[\s.-]?)?\(?\b(\d{3})\)?[\s.-]?(\d{3})[\s.-]?(\d{4})\b/g)) {
      const label = /\b(fax|f)\b\s*[:.]/i.test(line) || /\bfax\b/i.test(line) ? "fax" : /\b(cell|mobile|mob|c)\b\s*[:.]?/i.test(line) ? "mobile" : /\b(office|o|direct|d|work|main|tel|phone|p)\b\s*[:.]?/i.test(line) ? "office" : undefined;
      if (label === "fax") continue;
      out.push({ number: `${m[1]}${m[2]}${m[3]}`, label });
    }
  }
  return out.slice(0, 3);
}

/** The people on a job in Homebase, with their role on it. */
export function noteJobContacts(hub: Hub, jobNumber: number, jobName: string, contacts: Contact[]) {
  for (const c of contacts) {
    const e = c.email?.toLowerCase();
    if (e && skip(hub, e)) continue;
    const p = upsert(hub, { email: e || undefined, name: c.name, homebaseId: c.id });
    if (!p) continue;
    if (c.phone) addPhone(p, c.phone, "job");
    if (c.title && !p.title) p.title = c.title;
    if (c.company && !p.company) p.company = c.company;
    const role = c.roles?.filter((r) => r !== "Primary").join(", ") || (c.role === "customer" ? "Customer" : c.role === "adjuster" ? "Adjuster" : "Contact");
    const j = p.jobs.find((x) => x.jobNumber === jobNumber);
    if (j) Object.assign(j, { name: jobName, role });
    else p.jobs.push({ jobNumber, name: jobName, role });
  }
  save(hub);
}

/** Homebase's record for these people: title, company and phones fill in. */
export function noteHomebasePeople(hub: Hub, people: HbPerson[]) {
  for (const h of people) {
    const e = h.email?.toLowerCase();
    if (e && skip(hub, e)) continue;
    const p = upsert(hub, { email: e, name: h.name, homebaseId: h.id });
    if (!p) continue;
    if (h.title) p.title = h.title;
    if (h.company) p.company = h.company;
    for (const ph of h.phones) addPhone(p, ph.number, "homebase", ph.label && ph.label !== "main" ? ph.label : undefined);
  }
  save(hub);
}

/**
 * A phone number Hunter put a name to (from the Unknown numbers list): added to that person if they're already in
 * the contacts by that name, else as a new person, and tied to a job when one is given so their texts file there.
 */
export function addPhoneContact(hub: Hub, o: { name: string; phone: string; jobNumber?: number; jobName?: string; role?: string }): Person {
  const s = load(hub);
  const name = cleanName(o.name) || o.name.trim();
  const d = digits(o.phone);
  if (!name) throw new Error("Type a name first.");
  if (d.length < 10) throw new Error("That isn't a full phone number.");
  let p = Object.values(s.people).find((x) => x.phones.some((ph) => digits(ph.number) === d)) ?? Object.values(s.people).find((x) => x.name && x.name.toLowerCase() === name.toLowerCase());
  const now = new Date().toISOString();
  if (!p) {
    p = { id: `tel:${d}`, name, emails: [], phones: [], jobs: [], emailCount: 0, firstSeen: now, lastSeen: now };
    s.people[p.id] = p;
  }
  if (!p.name || p.id.startsWith("tel:")) p.name = name;
  addPhone(p, o.phone, "you");
  if (/co-?worker/i.test(o.role ?? "") && !p.company) p.company = "Forefront Building + Restoration";
  if (o.jobNumber) {
    const j = p.jobs.find((x) => x.jobNumber === o.jobNumber);
    if (j) Object.assign(j, { name: o.jobName ?? j.name, role: o.role || j.role });
    else p.jobs.push({ jobNumber: o.jobNumber, name: o.jobName ?? "", role: o.role || "Contact" });
  }
  if (now > p.lastSeen) p.lastSeen = now;
  save(hub, true);
  return p;
}

/** Someone at Forefront: a company email address, Forefront as their company, or added as a coworker. */
export function isCoworker(hub: Hub, p: Person): boolean {
  const domain = hub.cfg.gmail.address.split("@")[1]?.toLowerCase() || "forefrontteam.com";
  return p.emails.some((e) => e.endsWith(`@${domain}`)) || /\bforefront\b/i.test(p.company ?? "") || p.jobs.some((j) => /co-?worker/i.test(j.role));
}

export function allContacts(hub: Hub): Person[] {
  return Object.values(load(hub).people).sort((a, b) => b.lastSeen.localeCompare(a.lastSeen));
}

/**
 * Finds people by name, email, company, phone or job (#3226 or the job's name). With `homebase`, Homebase's search
 * runs too and whatever it knows is merged in first, so the answer is as full as it can be.
 */
export async function findContacts(hub: Hub, q: string, o: { homebase?: boolean; limit?: number } = {}): Promise<Person[]> {
  const query = q.trim();
  if (o.homebase && query.length >= 3 && hub.homebase.searchContacts) {
    const hb = await hub.homebase.searchContacts(query.replace(/^#/, "")).catch(() => []);
    noteHomebasePeople(hub, hb);
  }
  const words = query.toLowerCase().replace(/^#/, "").split(/\s+/).filter(Boolean);
  const qd = digits(query);
  const hay = (p: Person) => [p.name, ...p.emails, p.company, p.title, ...p.jobs.flatMap((j) => [`#${j.jobNumber}`, String(j.jobNumber), j.name, j.role]), ...p.phones.map((x) => digits(x.number))].join(" ").toLowerCase();
  const list = allContacts(hub).filter((p) => !words.length || words.every((w) => hay(p).includes(w)) || (qd.length >= 4 && p.phones.some((x) => digits(x.number).includes(qd))));
  // Best first: name starts with the query, then people on jobs, then most recent.
  const score = (p: Person) => (words.length && p.name.toLowerCase().split(" ").some((n) => n.startsWith(words[0])) ? 2 : 0) + (p.jobs.length ? 1 : 0);
  return list.sort((a, b) => score(b) - score(a) || b.lastSeen.localeCompare(a.lastSeen)).slice(0, o.limit ?? 200);
}
