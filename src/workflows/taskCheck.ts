import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { aiProvider, complete } from "../agent/llm.js";
import type { Task } from "../connectors/tasks/index.js";
import { asLater, confirmOrReply } from "../core/approval.js";
import { retired, type Job } from "../core/job.js";
import type { Hub } from "../hub.js";
import { STAGE_STEP } from "./reminders.js";

/**
 * Keeps Hunter's to-do list true: every open Google Task is checked against its job (stage, who runs it now, what
 * has happened since the task was made) and sorted into still his, already done, not his (the project manager's
 * once a job is won, or someone else's), outdated (the job is closed, or the moment has passed), a duplicate, or one
 * whose title or date is wrong. Nothing changes without his OK: the changes come as one card in To review, and a
 * typed answer like "keep Morris" leaves those alone. A task he kept isn't questioned again until it changes.
 * Runs before each brief and from the "Check my tasks" button; the brief leaves flagged tasks out meanwhile.
 */
export type Verdict = "keep" | "done" | "not_mine" | "outdated" | "duplicate" | "fix";
export interface TaskVerdict {
  taskId: string;
  listId: string;
  title: string;
  jobNumber?: number;
  verdict: Verdict;
  why: string;
  newTitle?: string;
  newDue?: string;
}

/** Stages where the job is the project manager's to run. */
const PRODUCTION = new Set(["Job Won", "Waitlist", "WA/Contract Sent", "Job Prep", "Ordering Materials", "Materials Stand-by", "Scheduling", "Work In Progress", "On-Hold", "Job Complete", "Billing Prep", "Ready to Be Sent", "Sent To Insurance", "Invoiced", "Payment Received", "Lien/Collections"]);
const CLOSED = new Set(["Closed Lost", "Payment Received", "Invoiced", "Sent To Insurance", "Lien/Collections"]);

interface State {
  /** Tasks Hunter kept (said no to the change), with the task's "updated" stamp then: asked again only once it changes. */
  kept: Record<string, string>;
}
const file = (hub: Hub) => path.join(hub.cfg.stateDir, "task-check.json");
function load(hub: Hub): State {
  try { return existsSync(file(hub)) ? { kept: {}, ...JSON.parse(readFileSync(file(hub), "utf8")) } : { kept: {} }; } catch { return { kept: {} }; }
}
function save(hub: Hub, s: State) {
  mkdirSync(hub.cfg.stateDir, { recursive: true });
  writeFileSync(file(hub), JSON.stringify(s, null, 1));
}

/** Tasks the last check said were wrong: the brief leaves them out until Hunter has answered. */
export const flaggedTasks = new Set<string>();

const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9 ]+/g, " ").replace(/\s+/g, " ").trim();

/** The job a task is about: the number in its notes or title, else the job name it starts with ("Morris - ..."). */
export function jobOfTask(t: Task, jobs: Job[]): Job | undefined {
  const n = t.jobNumber ?? (Number(`${t.title} ${t.notes ?? ""}`.match(/#(\d{3,6})\b/)?.[1]) || undefined);
  if (n) return jobs.find((j) => j.jobNumber === n);
  const head = norm(t.title.split(/\s+[-–—]\s+/)[0] ?? "");
  if (!head) return undefined;
  const hits = jobs.filter((j) => j.name && norm(j.name) === head);
  return hits.length === 1 ? hits[0] : undefined;
}

/** What the rules alone can settle: closed jobs and duplicates. */
export function ruleVerdicts(tasks: Task[], jobs: Job[], now = Date.now()): Map<string, TaskVerdict> {
  const out = new Map<string, TaskVerdict>();
  const base = (t: Task, j?: Job) => ({ taskId: t.id, listId: t.listId, title: t.title, jobNumber: j?.jobNumber });
  for (const t of tasks) {
    const j = jobOfTask(t, jobs);
    if (j && (CLOSED.has(j.stage) || retired(j, now))) out.set(t.id, { ...base(t, j), verdict: "outdated", why: `${j.name} is closed (${j.stage || "closed in Homebase"})` });
  }
  // Same job and the same words: keep the oldest.
  const seen = new Map<string, Task>();
  for (const t of [...tasks].sort((a, b) => (a.updated || "").localeCompare(b.updated || ""))) {
    if (out.has(t.id)) continue;
    const j = jobOfTask(t, jobs);
    const key = `${j?.jobNumber ?? ""}|${norm(t.title)}`;
    const first = seen.get(key);
    if (first) out.set(t.id, { ...base(t, j), verdict: "duplicate", why: `the same as "${first.title}"` });
    else seen.set(key, t);
  }
  return out;
}

const SCHEMA = {
  type: "object",
  properties: {
    tasks: {
      type: "array",
      items: {
        type: "object",
        properties: {
          tag: { type: "string" },
          verdict: { type: "string", enum: ["keep", "done", "not_mine", "outdated", "fix"] },
          why: { type: "string", description: "one short sentence a person would understand, naming the fact it rests on" },
          newTitle: { type: "string", description: "only for fix: the corrected title, in the same \"Job name - what to do\" style" },
          newDue: { type: "string", description: "only for fix: a corrected due date YYYY-MM-DD" },
        },
        required: ["tag", "verdict", "why"],
      },
    },
  },
  required: ["tasks"],
};

/** Looks at every open task. Returns the changes it would make (none are made here). */
export async function checkTasks(hub: Hub, o: { now?: Date } = {}): Promise<{ checked: number; changes: TaskVerdict[] }> {
  if (!hub.tasks.connected()) return { checked: 0, changes: [] };
  const now = o.now ?? new Date();
  const s = load(hub);
  const all = (await hub.tasks.tasks().catch(() => [])).filter((t) => !t.completed);
  const tasks = all.filter((t) => s.kept[t.id] !== t.updated);
  const jobs = hub.jobs.list();
  const rules = ruleVerdicts(tasks, jobs, now.getTime());
  // Who runs each job now, from Homebase (one call).
  const people = new Map<number, { estimator?: string; projectManager?: string }>();
  for (const j of await hub.homebase.listJobs({ openOnly: true, details: true }).catch(() => [])) if (j.people) people.set(j.jobNumber, j.people);

  const rest = tasks.filter((t) => !rules.has(t.id)).slice(0, 60);
  const ai: TaskVerdict[] = [];
  if (rest.length && aiProvider(hub) !== "off") {
    const today = now.toLocaleDateString("en-CA", { timeZone: "America/Denver" });
    const lines = rest.map((t, i) => {
      const j = jobOfTask(t, jobs);
      const p = j ? people.get(j.jobNumber) : undefined;
      const facts = j
        ? [`job "${j.name}" (#${j.jobNumber}), stage ${j.stage || "?"}${j.stageSince ? ` since ${j.stageSince.slice(0, 10)}` : ""}${PRODUCTION.has(j.stage) ? " (the project manager's now)" : ` (next step: ${STAGE_STEP[j.stage] ?? "check on the job"})`}`,
           p?.projectManager ? `PM ${p.projectManager}` : "", p?.estimator ? `estimator ${p.estimator}` : "",
           j.sendoff.sentAt || j.sendoff.drafts.some((d) => d.sentAt) ? `estimate sent ${(j.sendoff.sentAt || j.sendoff.drafts.find((d) => d.sentAt)?.sentAt || "").slice(0, 10)}` : j.estimate.status !== "none" ? `estimate ${j.estimate.status}` : "",
           j.pulse.lastTouch ? `last contact ${j.pulse.lastTouchAt.slice(0, 10)}: ${j.pulse.lastTouch.slice(0, 120)}` : "",
           j.log.slice(-4).map((l) => `${l.at.slice(0, 10)} ${l.what.slice(0, 100)}`).join("; ")].filter(Boolean).join(" · ")
        : "no job found for it";
      return `[T${i + 1}] "${t.title}"${t.due ? ` due ${t.due}` : ""}, made/changed ${t.updated?.slice(0, 10) ?? "?"}${t.notes ? `. Notes: ${t.notes.replace(/\s+/g, " ").slice(0, 300)}` : ""}\n     Job facts: ${facts}`;
    });
    const r = await complete<{ tasks: { tag: string; verdict: Verdict; why: string; newTitle?: string; newDue?: string }[] }>(hub, {
      system: "You check an estimator's to-do list against the facts of each job. You only flag a task when a fact listed shows it's wrong; when unsure, keep it.",
      prompt: `Hunter Patterson is the estimator at Forefront Building + Restoration (Colorado reconstruction after water and fire damage). His job: scope walks, estimates, proposals, supplements, the adjuster, selections, until a job is won. Once a job is won (Job Won and later), running it is the project manager's: scheduling, materials, deposits, invoices, payments, permits, punch lists. Today is ${today}.

For each of his open Google Tasks, say:
- keep: it's his and still needs doing (also when you can't tell).
- done: the job facts show it already happened since the task was made (the estimate it says to send was sent, the walk it says to book has happened or the stage is past it, the email it says to answer was answered).
- not_mine: it's someone else's to do: the project manager's production work on a won job, or a task addressed to another person.
- outdated: it no longer makes sense (the moment has passed, the job moved on so the step doesn't apply).
- fix: it's his and still needed, but the title names the wrong job or person, or the due date is clearly wrong; give newTitle and/or newDue.
Give "why" as one short sentence naming the fact.

${lines.join("\n")}`,
      schema: SCHEMA,
    }).catch(() => null);
    for (const v of r?.tasks ?? []) {
      const i = Number(v.tag.replace(/\D/g, "")) - 1, t = rest[i];
      if (!t || v.verdict === "keep") continue;
      if (v.verdict === "fix" && !v.newTitle && !v.newDue) continue;
      ai.push({ taskId: t.id, listId: t.listId, title: t.title, jobNumber: jobOfTask(t, jobs)?.jobNumber, verdict: v.verdict, why: v.why, newTitle: v.newTitle?.trim() || undefined, newDue: /^\d{4}-\d{2}-\d{2}$/.test(v.newDue ?? "") ? v.newDue : undefined });
    }
  }
  const changes = [...rules.values(), ...ai];
  flaggedTasks.clear();
  for (const c of changes) flaggedTasks.add(c.taskId);
  return { checked: tasks.length, changes };
}

const VERB: Record<Verdict, string> = { keep: "Keep", done: "Close (done)", not_mine: "Close (not yours)", outdated: "Close (outdated)", duplicate: "Close (duplicate)", fix: "Fix" };
const line = (c: TaskVerdict) => c.verdict === "fix"
  ? `Fix "${c.title}"${c.newTitle ? ` -> "${c.newTitle}"` : ""}${c.newDue ? ` (due ${c.newDue})` : ""}: ${c.why}`
  : `${VERB[c.verdict]}: "${c.title}" (${c.why})`;

/**
 * Checks the tasks and asks once to make the changes. `asked`: from the button (the card pops up); otherwise it
 * waits in To review. A typed answer like "keep Morris, keep 2" leaves those out and does the rest.
 */
export async function reviewTasks(hub: Hub, o: { asked?: boolean } = {}): Promise<{ checked: number; changed: number; changes: TaskVerdict[] }> {
  const { checked, changes } = await checkTasks(hub);
  return { checked, changes, changed: changes.length ? await askAndApply(hub, changes, o) : 0 };
}

/** One card for all the changes, then makes the ones Hunter OKs. Returns how many tasks changed. */
export async function askAndApply(hub: Hub, changes: TaskVerdict[], o: { asked?: boolean } = {}): Promise<number> {
  const ask = () => confirmOrReply(hub.approver, `Clean up ${changes.length} of your tasks?`, [
    ...changes.map((c, i) => `${i + 1}. ${line(c)}`),
    "",
    `Closed tasks are only ticked off (with the reason in their notes), never deleted. Type "keep 2" or "keep Morris" to leave some alone.`,
  ]);
  const ans = o.asked ? await ask() : await asLater(ask);
  const s = load(hub);
  const keepWords = (ans.reply ?? "").match(/keep\s+([^,;]+)/gi)?.map((k) => k.replace(/^keep\s+/i, "").trim().toLowerCase()) ?? [];
  const kept = (c: TaskVerdict, i: number) => keepWords.some((w) => w === String(i + 1) || c.title.toLowerCase().includes(w));
  const go = ans.yes || (!!ans.reply && keepWords.length > 0);
  const all = await hub.tasks.tasks().catch(() => [] as Task[]);
  const stamp = (id: string) => all.find((t) => t.id === id)?.updated ?? "";
  let changed = 0;
  const today = new Date().toLocaleDateString("en-CA", { timeZone: "America/Denver" });
  for (const [i, c] of changes.entries()) {
    if (!go || kept(c, i)) { s.kept[c.taskId] = stamp(c.taskId); continue; }
    const t = all.find((x) => x.id === c.taskId);
    if (!t || t.completed) continue;
    try {
      if (c.verdict === "fix") await hub.tasks.update(c.listId, c.taskId, { ...(c.newTitle ? { title: c.newTitle } : {}), ...(c.newDue ? { due: c.newDue } : {}), notes: [t.notes, `Fixed by Keystone ${today}: ${c.why}`].filter(Boolean).join("\n") });
      else await hub.tasks.update(c.listId, c.taskId, { completed: true, notes: [t.notes, `Closed by Keystone ${today} (${VERB[c.verdict].replace(/^Close \(|\)$/g, "")}): ${c.why}`].filter(Boolean).join("\n") });
      changed++;
      if (c.jobNumber && hub.jobs.exists(c.jobNumber)) hub.jobs.log(c.jobNumber, `Task ${c.verdict === "fix" ? "fixed" : "closed"}: ${c.title} (${c.why})`);
    } catch (e) {
      hub.say(`Couldn't change the task "${c.title}": ${(e as Error).message}`);
    }
  }
  save(hub, s);
  flaggedTasks.clear();
  if (changed) hub.say(`Cleaned up ${changed} task${changed === 1 ? "" : "s"}.`);
  return changed;
}
