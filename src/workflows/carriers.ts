import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import type { Job } from "../core/job.js";
import type { Hub } from "../hub.js";

/**
 * How each insurance carrier wants its email: which address it goes to and what the subject has to be. State Farm,
 * for one, files email by claim number: everything goes to its claims inbox with only the claim number as the
 * subject. The rules are data (config/carriers.json; your own additions or changes in .hub/carriers.json win), and
 * Keystone applies them to every new email it drafts to insurance, whoever wrote the words. Replies inside an
 * existing thread keep that thread's address and subject.
 */
export interface CarrierRule {
  carrier: string;
  /** Lowercase pieces of the carrier's name as Homebase has it ("state farm"). */
  match: string[];
  to: string;
  /** "{claim}" is replaced by the job's claim number. */
  subject: string;
  note?: string;
}

export function carrierRules(hub: Hub): CarrierRule[] {
  const read = (f: string): CarrierRule[] => {
    try {
      const j = existsSync(f) ? JSON.parse(readFileSync(f, "utf8")) : [];
      return Array.isArray(j) ? j.filter((r) => r && r.carrier && r.to && Array.isArray(r.match)) : [];
    } catch {
      return [];
    }
  };
  const mine = read(path.join(hub.cfg.stateDir, "carriers.json"));
  const base = read(path.join(hub.cfg.hubRoot, "config", "carriers.json")).filter((r) => !mine.some((m) => m.carrier.toLowerCase() === r.carrier.toLowerCase()));
  return [...mine, ...base];
}

export function ruleForJob(hub: Hub, job: Pick<Job, "carrier"> | null | undefined): CarrierRule | null {
  const c = (job?.carrier ?? "").toLowerCase();
  if (!c) return null;
  return carrierRules(hub).find((r) => r.match.some((m) => c.includes(m.toLowerCase()))) ?? null;
}

const addr = (s: string) => s.match(/[\w.+-]+@[\w.-]+/)?.[0]?.toLowerCase() ?? "";

/** Whether a draft is going to the job's insurance (the carrier's inbox, anyone at the carrier, or the job's adjuster). */
export function isToInsurance(rule: CarrierRule, job: Pick<Job, "adjuster">, to: string[]): boolean {
  const domain = rule.to.split("@")[1]?.toLowerCase();
  const adj = job.adjuster.email.toLowerCase();
  return to.map(addr).some((a) => a && (a === rule.to.toLowerCase() || (domain && a.endsWith(`@${domain}`)) || (adj && a === adj)));
}

/**
 * A new email to insurance, made to follow the carrier's rule: To is the carrier's address (a named adjuster moves
 * to Cc), and the subject is what the carrier files by. Without a claim number the subject is left alone and
 * `missing` says so.
 */
export function applyCarrierRule<T extends { to: string[]; cc?: string[]; subject: string }>(rule: CarrierRule, job: Pick<Job, "claimNumber">, d: T): T & { missing?: string } {
  const others = d.to.filter((a) => addr(a) !== rule.to.toLowerCase());
  const cc = [...new Set([...(d.cc ?? []), ...others].filter((a) => addr(a) !== rule.to.toLowerCase()))];
  const claim = job.claimNumber.trim();
  return {
    ...d,
    to: [rule.to],
    cc,
    subject: claim ? rule.subject.replaceAll("{claim}", claim) : d.subject,
    ...(claim ? {} : { missing: `${rule.carrier} needs the claim number in the subject, and this job has none in Homebase.` }),
  };
}

/** The rules as a line for the AI's instructions. */
export function carrierRulesNote(hub: Hub): string {
  const rules = carrierRules(hub);
  if (!rules.length) return "";
  return `Insurance carriers' email rules (Keystone enforces them on new emails; follow them so the draft is right the first time): ${rules.map((r) => `${r.carrier}: send to ${r.to}, subject ${r.subject === "{claim}" ? "is only the claim number" : `"${r.subject}"`}`).join("; ")}. A reply inside an existing thread keeps that thread's subject and recipients.`;
}
