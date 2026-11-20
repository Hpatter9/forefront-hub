import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { aiProvider, complete } from "../agent/llm.js";
import { confirmOrReply } from "../core/approval.js";
import type { Hub } from "../hub.js";
import { timeline } from "./timeline.js";

/**
 * The short "where we are" line on a Proposal Submitted job's Homebase page, so a coworker who gets asked about
 * the job can answer without calling Hunter. Keystone writes it from the job's latest activity (emails, calls,
 * notes, texts, walks) with the free AI, dated, a sentence or two, and only when something new has happened since
 * the last one. Every write goes through one Yes/No card listing each job's new line.
 *
 * Which Homebase field holds it: HOMEBASE_UPDATE_FIELD in .env when set, otherwise the job's field whose name says
 * "update" (preferring one that also says proposal/submitted/stage). If none is found, Keystone says so and lists
 * the job's field names, so the right one can be set.
 */
export const UPDATE_STAGE = "Proposal Submitted";
const KNOWN_NOT = new Set(["customerNotes", "pmNotes", "toolAccess", "accessNotes", "updatedAt", "updatedBy", "lastUpdated"]);

export interface FieldPick { key: string; current: string }
export function findUpdateField(raw: Record<string, any>, override = ""): FieldPick | { candidates: string[] } {
  const flat: { path: string; key: string; value: unknown }[] = [];
  const walk = (o: any, at: string, depth: number) => {
    if (!o || typeof o !== "object" || Array.isArray(o) || depth > 3) return;
    for (const [k, v] of Object.entries(o)) {
      flat.push({ path: at ? `${at}.${k}` : k, key: k, value: v });
      walk(v, at ? `${at}.${k}` : k, depth + 1);
    }
  };
  walk(raw, "", 0);
  if (override) {
    const hit = flat.find((f) => f.key === override || f.path === override);
    return { key: override.split(".").at(-1)!, current: typeof hit?.value === "string" ? hit.value : "" };
  }
  const textual = flat.filter((f) => (typeof f.value === "string" || f.value === null) && !KNOWN_NOT.has(f.key) && !/(At|On|Date|By|Id)$/.test(f.key));
  // Homebase calls it "Proposal Submitted Notes" (shown on the recon dashboard): a proposal/submitted field that holds
  // notes, an update or a status. A plain "...update" field is the fallback.
  const proposalish = (k: string) => /proposal|submitted/i.test(k) && /note|update|status|comment/i.test(k);
  const score = (k: string) => (proposalish(k) ? 8 : 0) + (/submitted/i.test(k) ? 2 : 0) + (/update/i.test(k) ? 1 : 0);
  const best = textual.filter((f) => proposalish(f.key) || /update/i.test(f.key)).sort((a, b) => score(b.key) - score(a.key))[0];
  if (best) return { key: best.key, current: typeof best.value === "string" ? best.value : "" };
  return { candidates: flat.filter((f) => /update|status|note|comment|summary/i.test(f.key)).map((f) => `${f.path} (${Array.isArray(f.value) ? "list" : f.value === null ? "empty" : typeof f.value})`).slice(0, 30) };
}

/** Every field name on a job with its kind (never its value), lists included: for finding a field Keystone can't see. */
export function fieldMap(raw: unknown, at = "", depth = 0, out: string[] = []): string[] {
  if (depth > 6 || out.length > 600) return out;
  if (Array.isArray(raw)) {
    out.push(`${at}: list of ${raw.length}`);
    if (raw.length && raw[0] && typeof raw[0] === "object") fieldMap(raw[0], `${at}[]`, depth + 1, out);
  } else if (raw && typeof raw === "object") {
    for (const [k, v] of Object.entries(raw)) {
      const p = at ? `${at}.${k}` : k;
      if (v && typeof v === "object") fieldMap(v, p, depth + 1, out);
      else out.push(`${p}: ${v === null ? "empty" : typeof v}`);
    }
  }
  return out;
}

/** The lines of Homebase's API reference that talk about notes, proposals or the dashboard, with a little around each. */
export function docLines(docs: string, max = 220): string[] {
  let text = docs;
  try { text = JSON.stringify(JSON.parse(docs), null, 1); } catch { /* not JSON: use as is */ }
  const lines = text.replace(/<[^>]+>/g, " ").split(/\r?\n/).map((l) => l.trimEnd()).filter((l) => l.trim());
  const keep = new Set<number>();
  lines.forEach((l, i) => { if (/proposal.?submitted|submitted.?note|stage.?note|dashboard|proposal\w*note|notes?\b/i.test(l)) for (let j = Math.max(0, i - 1); j <= Math.min(lines.length - 1, i + 2); j++) keep.add(j); });
  return [...keep].sort((a, b) => a - b).slice(0, max).map((i) => lines[i].slice(0, 300));
}

/**
 * When the notes field can't be found: writes a small help file (field names and kinds only, no job details, plus
 * the matching lines of Homebase's API reference) so the right field can be worked out. Returns the file's path.
 */
/** Like fieldMap, but keeps the values of short label-like fields (kind, type, stage, section...), which say what a note is. */
export function shapeOf(raw: unknown, at = "", depth = 0, out: string[] = []): string[] {
  if (depth > 6 || out.length > 300) return out;
  if (Array.isArray(raw)) {
    out.push(`${at}: list of ${raw.length}`);
    for (const x of raw.slice(0, 3)) if (x && typeof x === "object") shapeOf(x, `${at}[]`, depth + 1, out);
  } else if (raw && typeof raw === "object") {
    for (const [k, v] of Object.entries(raw)) {
      const p = at ? `${at}.${k}` : k;
      if (v && typeof v === "object") shapeOf(v, p, depth + 1, out);
      else out.push(`${p}: ${v === null ? "empty" : typeof v}${typeof v === "string" && /^(kind|type|stage|section|category|scope|topic|tag|label|prefix|code)$/i.test(k) ? ` = "${v.slice(0, 60)}"` : typeof v === "boolean" ? ` = ${v}` : ""}`);
    }
  }
  return out;
}

/** Places the Proposal Submitted Notes might live in Homebase's API: looked at read-only (GET), never written. */
const PEEKS = (id: string) => [
  `/projects/${id}/notes`, `/projects/${id}/stage-notes`, `/projects/${id}/stage_notes`, `/projects/${id}/stageNotes`,
  `/projects/${id}/proposal-notes`, `/projects/${id}/proposal-submitted-notes`, `/projects/${id}/status-notes`, `/projects/${id}/status`,
  `/projects/${id}/notes?stage=Proposal%20Submitted`, `/projects/${id}/notes?kind=proposal_submitted`, `/projects/${id}/dashboard`, `/projects/${id}/updates`,
];

/**
 * When the notes field can't be found: writes a help file so the right place can be worked out, and puts a copy in
 * the Drive hand-off folder so Claude can read it without Hunter sending anything. It holds field names and kinds
 * (never values, except short labels like a note's "kind"), what a read-only look at the likely API paths returned,
 * and Homebase's own API reference. No customer details.
 */
export async function writeFieldHelp(hub: Hub, n: number, raw: Record<string, any>): Promise<string> {
  const file = path.join(hub.cfg.stateDir, "homebase-notes-help.txt");
  let docs = "", docsNote = "";
  try { docs = (await hub.homebase.apiDocs?.()) ?? ""; if (!docs) docsNote = "(this connection has no API reference)"; }
  catch (e) { docsNote = `(couldn't read the API reference: ${(e as Error).message})`; }
  const peeks: string[] = [];
  const id = String(raw.id ?? "");
  if (hub.homebase.peek && id) {
    for (const p of PEEKS(id)) {
      try {
        const r = await hub.homebase.peek(p);
        peeks.push(`GET ${p.replace(id, ":id")} -> ${r.status}`, ...(r.status < 300 ? shapeOf(r.json).slice(0, 60).map((l) => `    ${l}`) : []));
      } catch (e) { peeks.push(`GET ${p.replace(id, ":id")} -> failed (${(e as Error).message.slice(0, 80)})`); }
    }
  }
  let pretty = docs;
  try { pretty = JSON.stringify(JSON.parse(docs), null, 1); } catch { /* not JSON */ }
  mkdirSync(hub.cfg.stateDir, { recursive: true });
  writeFileSync(file, [`Keystone couldn't find the Proposal Submitted Notes. Made ${new Date().toISOString()} from job #${n}.`, "No customer details are in this file: names of fields, kinds, and Homebase's API reference.", "",
    "== Every field on the job ==", ...fieldMap(raw), "", "== A read-only look at likely places ==", ...(peeks.length ? peeks : ["(this connection can't look)"]), "",
    "== Homebase API reference: lines about notes, proposals, the dashboard ==", docsNote, ...docLines(docs), "", "== Homebase API reference, whole ==", pretty.slice(0, 400_000)].join("\n"));
  // A copy where Claude can read it (the Drive hand-off folder), when Drive is connected.
  try {
    const d = hub.drive;
    const root = d?.connected() ? await d.findFolder("Keystone hand-off") : null;
    if (d && root) await d.upload((await d.ensureFolder("_keystone", root.id)).id, file);
  } catch { /* the local file is still there */ }
  return file;
}

interface State { [job: string]: { text: string; at: string; basedOn: string } }
const stateFile = (hub: Hub) => path.join(hub.cfg.stateDir, "status-updates.json");
const load = (hub: Hub): State => { try { return existsSync(stateFile(hub)) ? JSON.parse(readFileSync(stateFile(hub), "utf8")) : {}; } catch { return {}; } };
const save = (hub: Hub, s: State) => { mkdirSync(hub.cfg.stateDir, { recursive: true }); writeFileSync(stateFile(hub), JSON.stringify(s, null, 1)); };

const SCHEMA = { type: "object", properties: { update: { type: "string" }, nothingNew: { type: "boolean" } }, required: ["update", "nothingNew"] };
const shortDate = (d = new Date()) => d.toLocaleDateString("en-US", { timeZone: "America/Denver", month: "numeric", day: "numeric" });

/** The new line for one job, or null when nothing has happened since the last one. */
export async function draftUpdate(hub: Hub, n: number, o: { current?: string; force?: boolean } = {}): Promise<{ text: string; basedOn: string } | null> {
  const items = (await timeline(hub, n)).filter((t) => t.kind !== "draft");
  const latest = items[0]?.at ?? "";
  const prev = load(hub)[n];
  if (!o.force && prev && latest && latest <= prev.basedOn) return null;
  if (!items.length) return null;
  const job = await hub.homebase.getJob(n).catch(() => null);
  const recent = items.slice(0, 25).map((t) => `${t.at.slice(0, 10)} ${t.kind}${t.direction ? ` ${t.direction}` : ""}${t.who ? ` (${t.who})` : ""}: ${t.title}${t.body ? ` | ${t.body.replace(/\s+/g, " ").slice(0, 400)}` : ""}`).join("\n");
  const r = await complete<{ update: string; nothingNew: boolean }>(hub, {
    system: "You write the one-line status update on a reconstruction job's page in Forefront's job system, for coworkers who get asked where a job stands. Plain words, no greeting, no names of tools.",
    prompt: `Job #${n} ${job?.name ?? ""}, stage ${UPDATE_STAGE}${job?.proposalAmount ? `, proposal $${job.proposalAmount}` : ""}.
Its Proposal Submitted Notes now (this gets replaced, not added to): ${o.current?.trim() ? `"${o.current.trim()}"` : "(blank)"}

Recent activity, newest first:
${recent}

Write the job's current status, to replace the old one: one or two short sentences, under 200 characters, starting with today's date "${shortDate()}: ". Only where it stands now and what's next or who we're waiting on; no history of earlier steps (e.g. "${shortDate()}: Adjuster agreed to the supplement except carpet; revised estimate going to Liberty Mutual this week."). Use only what the activity shows; no guesses. If nothing in the activity changes the current status, set nothingNew true.`,
    schema: SCHEMA,
    fast: true,
  });
  if (!r || (r.nothingNew && o.current?.trim() && !o.force)) return null;
  const text = r.update.replace(/\s+/g, " ").trim().slice(0, 300);
  return text ? { text, basedOn: latest } : null;
}

/**
 * Hunter's typed changes to the card: "Williams: new text" replaces that job's line (by name or job number), "skip
 * Williams" leaves it out. One change per line (or separated by ";").
 */
export function applyReply<T extends { n: number; name: string; text: string }>(plan: T[], reply: string): { plan: T[]; matched: number } {
  const out = plan.map((p) => ({ ...p }));
  const skip = new Set<number>();
  let matched = 0;
  const find = (who: string) => {
    const w = who.replace(/#/g, "").trim().toLowerCase();
    return out.find((p) => String(p.n) === w || p.name.toLowerCase() === w) ?? out.find((p) => w.length > 2 && (p.name.toLowerCase().includes(w) || w.includes(p.name.toLowerCase())));
  };
  for (const line of reply.split(/\n|;/).map((l) => l.trim()).filter(Boolean)) {
    const s = line.match(/^(?:skip|leave out|don'?t update|not)\s+(.+)$/i);
    if (s) { const p = find(s[1]); if (p) { skip.add(p.n); matched++; } continue; }
    const m = line.match(/^([^:]{2,60}):\s*(.+)$/);
    const p = m && find(m[1]);
    if (p && m) { p.text = /^\d{1,2}\/\d{1,2}:/.test(m[2]) ? m[2].trim() : `${shortDate()}: ${m[2].trim()}`; matched++; }
  }
  return { plan: out.filter((p) => !skip.has(p.n)), matched };
}

/**
 * Brings the update line up to date on every Proposal Submitted job of Hunter's: drafts each job's new line, asks
 * once (all the lines on one card), then writes them. Returns what was written.
 */
export async function updateProposalJobs(hub: Hub, o: { force?: boolean } = {}): Promise<{ written: number; skipped: number; problem?: string }> {
  if (aiProvider(hub) !== "gemini") return { written: 0, skipped: 0, problem: "Status updates are written by the free AI (Gemini), which is off on this machine." };
  if (!hub.homebase.rawJob || !hub.homebase.updateFields) return { written: 0, skipped: 0, problem: "This Homebase connection can't write job fields." };
  const jobs = (await hub.homebase.listJobs({ openOnly: true, mine: hub.cfg.homebase.me })).filter((j) => j.stage === UPDATE_STAGE);
  const override = hub.cfg.homebase.updateField ?? "";
  const plan: { n: number; name: string; key: string; text: string; basedOn: string }[] = [];
  let skipped = 0;
  for (const j of jobs) {
    try {
      const raw = await hub.homebase.rawJob(j.jobNumber);
      const pick = findUpdateField(raw, override);
      if ("candidates" in pick) {
        const help = await writeFieldHelp(hub, j.jobNumber, raw).catch(() => "");
        return { written: 0, skipped: jobs.length, problem: `Homebase didn't hand Keystone a Proposal Submitted Notes field on job #${j.jobNumber} (the closest it has: ${pick.candidates.join(", ") || "none"}).${help ? ` Keystone saved what it found (${help}) and put a copy in the Google Drive hand-off folder: tell Claude "the Homebase help file is in Drive" and it can finish the hookup.` : ""}` };
      }
      const d = await draftUpdate(hub, j.jobNumber, { current: pick.current, force: o.force });
      if (!d || d.text === pick.current.trim()) { skipped++; continue; }
      plan.push({ n: j.jobNumber, name: j.name, key: pick.key, ...d });
    } catch (e) {
      hub.say(`#${j.jobNumber}: couldn't write its update (${(e as Error).message.slice(0, 120)}).`);
      skipped++;
    }
  }
  if (!plan.length) return { written: 0, skipped };
  const answer = await confirmOrReply(hub.approver, `Replace the Proposal Submitted Notes on ${plan.length} Homebase job${plan.length === 1 ? "" : "s"} with the current status?`, [...plan.map((p) => `#${p.n} ${p.name}: ${p.text}`), "", "To change one, type it below and press Send my answer, e.g. \"Williams: waiting on the adjuster's carpet pricing\" (or \"skip Williams\"). The rest go in as shown."]);
  if (answer.reply) {
    const r = applyReply(plan, answer.reply);
    if (!r.matched) { hub.say(`Your answer didn't name one of the jobs (${plan.map((p) => p.name).join(", ")}), so no updates were written. Ask again with the job's name first, e.g. "Williams: ...".`); return { written: 0, skipped: skipped + plan.length }; }
    plan.splice(0, plan.length, ...r.plan);
  } else if (!answer.yes) return { written: 0, skipped: skipped + plan.length };
  const s = load(hub);
  let written = 0;
  for (const p of plan) {
    const r = await hub.homebase.updateFields(p.n, { [p.key]: p.text }).catch((e) => ({ [p.key]: { ok: false, message: (e as Error).message } }) as Record<string, { ok: boolean; message?: string }>);
    if (r[p.key] && r[p.key].ok === false) { hub.say(`#${p.n}: Homebase refused the update (${(r[p.key] as { message?: string }).message ?? ""}).`); continue; }
    s[p.n] = { text: p.text, at: new Date().toISOString(), basedOn: p.basedOn };
    if (hub.jobs.exists(p.n)) hub.jobs.log(p.n, `Homebase status update: ${p.text}`);
    written++;
  }
  save(hub, s);
  hub.say(`Updated the status on ${written} Proposal Submitted job${written === 1 ? "" : "s"} in Homebase.`);
  return { written, skipped };
}

/** One job's line, as Hunter (or the AI on his word) wrote it. Asks first. */
export async function setStatusUpdate(hub: Hub, n: number, text: string): Promise<string> {
  if (!hub.homebase.rawJob || !hub.homebase.updateFields) throw new Error("This Homebase connection can't write job fields.");
  const pick = findUpdateField(await hub.homebase.rawJob(n), hub.cfg.homebase.updateField ?? "");
  if ("candidates" in pick) throw new Error(`Couldn't find the Proposal Submitted update field on #${n}. Fields that might be it: ${pick.candidates.join(", ") || "(none)"}. Set HOMEBASE_UPDATE_FIELD in .env.`);
  const line = /^\d{1,2}\/\d{1,2}:/.test(text.trim()) ? text.trim() : `${shortDate()}: ${text.trim()}`;
  if (!(await hub.approver.confirm(`Replace the Proposal Submitted Notes on Homebase #${n}?`, [`Now: ${pick.current || "(blank)"}`, `New: ${line}`]))) return "Not changed.";
  const r = await hub.homebase.updateFields(n, { [pick.key]: line });
  if (r[pick.key]?.ok === false) throw new Error(`Homebase refused it: ${r[pick.key].message ?? r[pick.key].code ?? ""}`);
  const s = load(hub);
  s[n] = { text: line, at: new Date().toISOString(), basedOn: new Date().toISOString() };
  save(hub, s);
  if (hub.jobs.exists(n)) hub.jobs.log(n, `Homebase status update: ${line}`);
  return `Saved on Homebase #${n}: ${line}`;
}
