import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { Message, ThreadSummary } from "../connectors/gmail/types.js";
import type { Hub } from "../hub.js";
import { createGeneratedDraft } from "./generated.js";
import { allSigns, jobOfMail } from "./jobMail.js";

/**
 * When a homeowner signs the reconstruction agreement, Homebase emails them a "Signed and on file" confirmation from
 * office@ with Hunter copied ("Your signed ... reconstruction agreement — <address>"). Keystone watches for that
 * and drafts the Project Handoff email: Hunter introducing the project manager, who is copied. It's a draft in AI
 * drafts; Hunter reads it and sends it. One per signing, and never when a hand-off already went to that person.
 */
export const HANDOFF_SUBJECT = "Project Handoff";

/** Hunter's own hand-off email, word for word (the ones he sent in September 2026), with the names filled in. */
export function handoffBody(first: string, pm: string): string {
  return [
    `Hi ${first || "there"},`,
    `Your project is officially set up and ready to move into the next phase. From here, ${pm} will be your Project Manager and main point of contact.`,
    `${pm} will review your contract, get your materials ordered, and handle scheduling. She'll keep you updated on timing as things come together.`,
    `I've copied her on this email. Feel free to reply directly to her with any questions going forward.`,
    `Thanks again for trusting us with your project!`,
  ].join("\n\n");
}

export interface Signing { messageId: string; to: string; signedBy: string; property: string; document: string; at: string }

const addr = (s: string) => s.match(/[\w.+-]+@[\w.-]+/)?.[0]?.toLowerCase() ?? "";
// "Your signed clarry - reconstruction agreement — 2830 South Vine Street, Denver": the long dash comes before the address.
const SUBJECT = /^Your signed (.+?)\s+[—–]\s+(.+)$/i;

/** Reads a "Signed and on file" confirmation; null for anything else (and for a re-signed, updated agreement). */
export function parseSigning(m: Message): Signing | null {
  if (!/^office@/i.test(addr(m.from))) return null;
  const s = m.subject.match(SUBJECT);
  if (!s || !/agreement|contract|work authorization/i.test(s[1])) return null;
  // An updated agreement is a change on a job that was already handed off.
  if (/\bupdated\b|change order|supplement/i.test(s[1])) return null;
  const line = (k: string) => m.body.match(new RegExp(`\\*?${k}:\\*?\\s*(.+)`, "i"))?.[1]?.trim() ?? "";
  const to = m.to.map(addr).find((a) => a && !a.endsWith("@forefrontteam.com")) ?? "";
  if (!to) return null;
  return { messageId: m.id, to, signedBy: line("Signed by") || m.body.match(/Hello ([^,\n]+),/)?.[1]?.trim() || "", property: line("Property") || s[2].trim(), document: s[1].trim(), at: isNaN(Date.parse(m.date)) ? new Date().toISOString() : new Date(m.date).toISOString() };
}

interface State { handled: Record<string, { at: string; result: string; job?: number }> }
const file = (hub: Hub) => path.join(hub.cfg.stateDir, "contract-signed.json");
function load(hub: Hub): State {
  try { if (existsSync(file(hub))) return { handled: {}, ...JSON.parse(readFileSync(file(hub), "utf8")) }; } catch { /* start fresh */ }
  return { handled: {} };
}
function save(hub: Hub, s: State) {
  mkdirSync(hub.cfg.stateDir, { recursive: true });
  const cut = Date.now() - 90 * 86_400_000;
  for (const [k, v] of Object.entries(s.handled)) if (Date.parse(v.at) < cut) delete s.handled[k];
  writeFileSync(file(hub), JSON.stringify(s, null, 1));
}

export interface HandoffResult { messageId: string; result: "drafted" | "already" | "no-job"; jobNumber?: number; to: string; name: string }

let running = false;
/** Looks for new signed-agreement confirmations and drafts the hand-off for each. Safe to call often. */
export async function checkContractsSigned(hub: Hub): Promise<HandoffResult[]> {
  if (running || !hub.cfg.handoff.on) return [];
  running = true;
  const out: HandoffResult[] = [];
  try {
    const state = load(hub);
    let list: ThreadSummary[];
    if (hub.gmail.kind === "google") list = await hub.gmail.search('from:office@forefrontteam.com subject:"Your signed" newer_than:7d', 20);
    else list = ((await hub.gmail.listThreads?.({ q: "signed" }).catch(() => ({ threads: [] })))?.threads ?? []);
    const all = allSigns(hub);
    const pmFirst = hub.cfg.handoff.pmName.split(/\s+/)[0];
    for (const t of list) {
      if (!/^Your signed /i.test(t.subject)) continue;
      const th = await hub.gmail.getThread(t.id, t.historyId).catch(() => null);
      for (const m of th?.messages ?? []) {
        if (state.handled[m.id]) continue;
        const s = parseSigning(m);
        if (!s) continue;
        const done = (result: HandoffResult["result"], jobNumber?: number) => {
          state.handled[m.id] = { at: new Date().toISOString(), result, job: jobNumber };
          out.push({ messageId: m.id, result, jobNumber, to: s.to, name: s.signedBy });
        };
        // Already handed off (sent, or a draft waiting): once is enough.
        const before = hub.gmail.kind === "google"
          ? await hub.gmail.search(`subject:"${HANDOFF_SUBJECT}" to:${s.to} (in:sent OR in:draft) newer_than:120d`, 3).catch(() => [])
          : ((await hub.gmail.listThreads?.({ q: HANDOFF_SUBJECT }).catch(() => ({ threads: [] })))?.threads ?? []).filter((x) => x.subject === HANDOFF_SUBJECT && (x.to ?? "").toLowerCase().includes(s.to));
        if (before.length) { done("already"); continue; }
        const n = jobOfMail(all, `${m.subject}\n${m.body}`, [...m.to, ...m.cc]) ?? undefined;
        const job = n && hub.jobs.exists(n) ? hub.jobs.get(n) : null;
        const first = (s.signedBy || job?.customer.attention || job?.customer.name || "").trim().split(/\s+/)[0] ?? "";
        await createGeneratedDraft(hub, {
          to: [s.signedBy ? `${s.signedBy} <${s.to}>` : s.to],
          cc: [`${hub.cfg.handoff.pmName} <${hub.cfg.handoff.pmEmail}>`],
          bcc: job ? [`office+${job.jobNumber}@forefrontteam.com`] : [],
          subject: HANDOFF_SUBJECT,
          body: handoffBody(first, pmFirst),
          attachments: [],
        }, { jobNumber: job?.jobNumber, source: "Contract signed" });
        if (job) hub.jobs.log(job.jobNumber, `Draft (handoff) "${HANDOFF_SUBJECT}" to ${s.to}: agreement signed ${s.at.slice(0, 10)}`);
        hub.say(`${job ? `#${job.jobNumber} ${job.name}` : s.property}: ${s.signedBy || s.to} signed the agreement. The hand-off email introducing ${pmFirst} is in AI drafts for you to send.`);
        done(job ? "drafted" : "no-job", job?.jobNumber);
      }
    }
    save(hub, state);
  } finally {
    running = false;
  }
  return out;
}
