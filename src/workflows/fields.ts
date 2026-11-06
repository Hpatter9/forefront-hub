import type { FieldResult } from "../connectors/homebase/types.js";
import type { Hub } from "../hub.js";

/**
 * The job fields the hub edits, grouped the way the Homebase job page groups them. `key` is the name
 * PATCH /api/v1/projects/:id takes; `read` finds the current value in the job read (GET /projects/:id), which keeps
 * some fields under `brief`, `money`, `loss` or `platform`.
 */
export type FieldType = "text" | "textarea" | "money" | "percent" | "select" | "url" | "account" | "person";

export interface FieldDef {
  key: string;
  label: string;
  section: string;
  type: FieldType;
  /** Fixed choices, or the name of a Homebase vocabulary list. */
  options?: string[] | "fundingTypes" | "claimStatuses";
  help?: string;
}

export const SECTIONS = ["Job", "Insurance", "Money", "Property & access", "Notes"] as const;

export const FIELDS: FieldDef[] = [
  { key: "detail", label: "Loss type", section: "Job", type: "text" },
  { key: "propertyType", label: "Property type", section: "Job", type: "select", options: ["Residential", "Commercial"] },
  { key: "estimator", label: "Estimator", section: "Job", type: "person", help: "A name as it appears on Homebase's team list" },
  { key: "preferredContactMethod", label: "Preferred contact", section: "Job", type: "select", options: ["Call", "Text", "Email"] },
  { key: "picturesLink", label: "CompanyCam photos", section: "Job", type: "url" },

  { key: "fundingType", label: "Funding", section: "Insurance", type: "select", options: "fundingTypes" },
  { key: "claimStatus", label: "Claim status", section: "Insurance", type: "select", options: "claimStatuses" },
  { key: "claimNumber", label: "Claim number", section: "Insurance", type: "text" },
  { key: "carrier", label: "Carrier", section: "Insurance", type: "account", help: "Search Homebase's carrier accounts" },
  { key: "deductible", label: "Deductible", section: "Insurance", type: "money" },
  { key: "poWoNumber", label: "PO / WO number", section: "Insurance", type: "text" },

  { key: "proposalAmount", label: "Proposal amount", section: "Money", type: "money", help: "Homebase sets the proposal submitted date to today when this changes, which restarts the Day 2/5/10/21 follow-ups" },
  { key: "estimatedCosts", label: "Estimated costs", section: "Money", type: "money", help: "What the job costs us, not the customer" },
  { key: "desiredMargin", label: "Desired margin", section: "Money", type: "percent" },
  { key: "mitEstimatedInvoice", label: "Mit estimated invoice", section: "Money", type: "money" },

  { key: "lockboxCode", label: "Lockbox code", section: "Property & access", type: "text" },
  { key: "gateCode", label: "Gate code", section: "Property & access", type: "text" },
  { key: "alarm", label: "Alarm", section: "Property & access", type: "text" },
  { key: "pets", label: "Pets", section: "Property & access", type: "text" },
  { key: "parking", label: "Parking", section: "Property & access", type: "text" },
  { key: "elevatorAccess", label: "Elevator access", section: "Property & access", type: "text" },
  { key: "accessNotes", label: "Access notes", section: "Property & access", type: "textarea" },

  { key: "customerNotes", label: "Customer notes", section: "Notes", type: "textarea" },
  { key: "pmNotes", label: "PM notes", section: "Notes", type: "textarea" },
  { key: "toolAccess", label: "Notes for subs", section: "Notes", type: "textarea" },
];

/** A field's current value from the job read: its own key wherever Homebase keeps it. */
export function readField(raw: Record<string, any>, key: string): unknown {
  const places = [raw, raw.brief, raw.money, raw.loss, raw.platform, raw.platform?.access, raw.platform?.funding, raw.people];
  for (const p of places) if (p && p[key] !== undefined && p[key] !== null) return p[key];
  return null;
}

export function display(v: unknown): string {
  if (v === null || v === undefined || v === "") return "(blank)";
  if (typeof v === "object") return (v as any).name ?? JSON.stringify(v);
  return String(v);
}

export function fieldValues(raw: Record<string, any>) {
  return Object.fromEntries(FIELDS.map((f) => [f.key, readField(raw, f.key)]));
}

/**
 * Saves job fields to Homebase after showing Hunter each change (old -> new). Returns Homebase's answer per field;
 * a field Homebase refuses comes back with its sentence and the others still save.
 */
export async function editFields(hub: Hub, jobNumber: number, changes: Record<string, unknown>, labels: Record<string, string> = {}): Promise<Record<string, FieldResult> | null> {
  if (!hub.homebase.updateFields || !hub.homebase.rawJob) throw new Error("This Homebase connection can't edit fields.");
  const keys = Object.keys(changes);
  if (!keys.length) return {};
  const raw = await hub.homebase.rawJob(jobNumber);
  const lines = keys.map((k) => {
    const def = FIELDS.find((f) => f.key === k);
    const newShown = labels[k] ?? display(changes[k]);
    return `${def?.label ?? k}: ${display(readField(raw, k))} → ${newShown}`;
  });
  if (keys.includes("proposalAmount")) lines.push("Changing the proposal amount sets the proposal submitted date to today in Homebase.");
  if (!(await hub.approver.confirm(`Save ${keys.length === 1 ? "this change" : `these ${keys.length} changes`} to Homebase #${jobNumber}?`, lines))) return null;
  const results = await hub.homebase.updateFields(jobNumber, changes);
  const failed = Object.entries(results).filter(([, r]) => !r.ok);
  if (hub.jobs.exists(jobNumber)) hub.jobs.log(jobNumber, `Homebase fields saved: ${keys.filter((k) => results[k]?.ok !== false).join(", ") || "none"}`);
  hub.say(failed.length ? `Saved ${keys.length - failed.length} of ${keys.length}. Homebase refused: ${failed.map(([k, r]) => `${FIELDS.find((f) => f.key === k)?.label ?? k} (${r.message ?? r.code})`).join("; ")}` : `Saved to Homebase #${jobNumber}.`);
  return results;
}

/** Adds (or adopts, by exact name) a person in Homebase and puts them on the job as adjuster 1 or 2. */
export async function setAdjuster(hub: Hub, jobNumber: number, slot: 1 | 2, a: { first: string; last: string; email?: string; phone?: string }) {
  if (!hub.homebase.createContact || !hub.homebase.updateFields) throw new Error("This Homebase connection can't add contacts.");
  const details = [`${a.first} ${a.last}`, a.email ?? "", a.phone ?? ""].filter(Boolean);
  if (!(await hub.approver.confirm(`Make this person adjuster ${slot} on Homebase #${jobNumber}?`, details))) return null;
  const c = await hub.homebase.createContact(jobNumber, { ...a, title: "Adjuster" });
  if (c.adopted && c.ignored) hub.say(`Homebase already had ${a.first} ${a.last}; it kept their saved details (${Object.keys(c.ignored).join(", ")} differ). Edit the person in Homebase if those changed.`);
  const r = await hub.homebase.updateFields(jobNumber, { [`adjuster${slot}`]: c.id });
  const res = r[`adjuster${slot}`];
  if (res && !res.ok) throw new Error(`Homebase refused the adjuster: ${res.message ?? res.code}`);
  if (hub.jobs.exists(jobNumber)) {
    hub.jobs.upsert(jobNumber, { adjuster: { name: `${a.first} ${a.last}`.trim(), email: a.email ?? "", phone: a.phone ?? "" }, insurance: "claim" });
    hub.jobs.log(jobNumber, `Homebase: adjuster ${slot} = ${a.first} ${a.last}`);
  }
  hub.say(`${a.first} ${a.last} is adjuster ${slot} on Homebase #${jobNumber}.`);
  return c.id;
}

/** Edits a person's own details (the customer's email or phone, say). */
export async function editContact(hub: Hub, jobNumber: number, contactId: string, name: string, c: { first?: string; last?: string; email?: string; phone?: string }) {
  if (!hub.homebase.updateContact) throw new Error("This Homebase connection can't edit contacts.");
  const lines = Object.entries(c).filter(([, v]) => v !== undefined).map(([k, v]) => `${k}: ${v}`);
  if (!lines.length) return null;
  if (!(await hub.approver.confirm(`Update ${name} in Homebase?`, lines))) return null;
  const r = await hub.homebase.updateContact(contactId, c);
  const failed = Object.entries(r).filter(([, x]) => !x.ok);
  hub.say(failed.length ? `Homebase refused: ${failed.map(([k, x]) => `${k} (${x.message ?? x.code})`).join("; ")}` : `Updated ${name} in Homebase.`);
  if (hub.jobs.exists(jobNumber)) hub.jobs.log(jobNumber, `Homebase contact ${name} updated`);
  return r;
}
