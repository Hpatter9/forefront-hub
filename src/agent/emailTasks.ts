import { query } from "@anthropic-ai/claude-agent-sdk";
import { aiReady, complete } from "./llm.js";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { Message } from "../connectors/gmail/types.js";
import type { Hub } from "../hub.js";
import { matchJob } from "../workflows/inbox.js";
import { isAutomated } from "../workflows/reminders.js";
import { jobTaskTitle, withJobNote } from "../workflows/taskTitle.js";

/**
 * Turns incoming email into Google Tasks on its own: Claude reads each new email from a person and, when it asks
 * Hunter to do something, adds a task (with the job number when the email is about a job, a due date from the email
 * or the next workday, and a link back to the email). FYI-only email gets no task, and a thread that already has an
 * open task from Keystone gets no duplicate. Runs with the inbox check; switch off with HUB_EMAIL_TASKS=off.
 */
interface State {
  since?: string;
  done: Record<string, string[]>; // messageId -> task ids made from it ([] = looked at, nothing to do)
  byThread: Record<string, { listId: string; id: string; title: string }[]>;
}

const file = (hub: Hub) => path.join(hub.cfg.stateDir, "email-tasks.json");
const load = (hub: Hub): State => (existsSync(file(hub)) ? JSON.parse(readFileSync(file(hub), "utf8")) : { done: {}, byThread: {} });
function save(hub: Hub, s: State) {
  mkdirSync(hub.cfg.stateDir, { recursive: true });
  writeFileSync(file(hub), JSON.stringify(s, null, 2));
}

export function enabled(hub: Hub) {
  return (
    (process.env.HUB_EMAIL_TASKS ?? "on") !== "off" &&
    aiReady(hub) &&
    hub.gmail.kind === "google" &&
    !!hub.gmail.listThreads &&
    (hub.gmail.fullAccess?.() ?? false) &&
    hub.tasks.connected()
  );
}

function nextWorkday(d = new Date()) {
  const x = new Date(d);
  do x.setDate(x.getDate() + 1);
  while ([0, 6].includes(x.getDay()));
  return x.toLocaleDateString("en-CA", { timeZone: "America/Denver" });
}

export interface ProposedTask {
  title: string;
  due?: string;
  notes?: string;
}

const SCHEMA = {
  type: "object",
  properties: {
    tasks: {
      type: "array",
      items: {
        type: "object",
        properties: { title: { type: "string" }, due: { type: "string", description: "YYYY-MM-DD, only if the email gives or implies a deadline" }, notes: { type: "string" } },
        required: ["title"],
        additionalProperties: false,
      },
    },
  },
  required: ["tasks"],
  additionalProperties: false,
};

/** Claude's read of one email: the things it asks Hunter to do, as short task titles. */
export async function proposeTasks(hub: Hub, m: Message, ctx: { jobNumber?: number; jobName?: string; jobStage?: string; openTasks: string[] }): Promise<ProposedTask[]> {
  const today = new Date().toLocaleDateString("en-CA", { timeZone: "America/Denver", weekday: "long", year: "numeric", month: "2-digit", day: "2-digit" });
  const prompt = `You help Hunter Patterson, the estimator at Forefront Building + Restoration (Colorado reconstruction after water/fire damage), keep his Google Tasks. Today is ${today} (America/Denver).

Read this email to him and list what it asks HIM to do: reply with something, send a document or photos, schedule a visit, call someone, revise an estimate, chase a signature. Rules:
- Only real asks or commitments with a next step for Hunter. An FYI, a thank-you, a receipt, a newsletter or "sounds good" gets NO task: return an empty list.
- Only what HUNTER has to do. If the ask is put to someone else on the email (it names them: "Shannon, can you...", "Kristi will send..."), or Hunter is only copied and nothing is asked of him, no task.
- Hunter is the estimator: walks, scope, estimates, proposals, supplements, the adjuster, selections before the job is won. Once a job is won (Job Won and later), running it is the project manager's (Shannon's): scheduling crews, ordering materials, deposits, invoices, payments, permits, punch lists. Those get NO task unless the email asks Hunter by name.
- One task per distinct action, at most 3. Each title is short: ${ctx.jobName ? `the job's name, a spaced dash, then what to do starting with a verb in lower case: e.g. "${ctx.jobName} - send Eileen the hallway photos", "${ctx.jobName} - check in on selections"` : `what to do, starting with a verb: e.g. "send Eileen the hallway photos"`}. No job numbers in the title.
- due: only when the email states or clearly implies a date ("by Friday", "before the 12th", "tomorrow"); otherwise leave it out.
- notes: one line of context if useful.
- These tasks are already open for this conversation; don't repeat them: ${ctx.openTasks.length ? ctx.openTasks.map((t) => `"${t}"`).join(", ") : "(none)"}.
${ctx.jobNumber ? `This email is about job #${ctx.jobNumber}${ctx.jobName ? ` (${ctx.jobName})` : ""}${ctx.jobStage ? `, now at the "${ctx.jobStage}" stage in Homebase` : ""}.` : ""}

From: ${m.from}
To: ${m.to.join(", ")}${m.cc.length ? `\nCc: ${m.cc.join(", ")}` : ""}
Date: ${m.date}
Subject: ${m.subject}

${m.body.slice(0, 8000)}`;
  let out: ProposedTask[] = [];
  const so = await complete<{ tasks?: ProposedTask[] }>(hub, { system: "You extract action items from email into short to-do titles. Be strict: no task unless the email needs Hunter to act.", prompt, schema: SCHEMA, fast: hub.cfg.ai.provider === "gemini" });
  out = (so?.tasks ?? []).slice(0, 3);
  return out.filter((t) => t.title?.trim());
}

/** Looks at the last two days of incoming mail and adds tasks for what needs Hunter. Returns what it added. */
export async function tasksFromInbox(hub: Hub, o: { max?: number } = {}): Promise<{ title: string; jobNumber?: number }[]> {
  if (!enabled(hub)) return [];
  const s = load(hub);
  s.since ??= new Date().toISOString(); // start from when this was first switched on: no back-filling old mail
  save(hub, s);
  const me = hub.cfg.gmail.address.toLowerCase();
  const added: { title: string; jobNumber?: number }[] = [];
  let looked = 0;
  const { threads } = await hub.gmail.listThreads!({ q: "newer_than:2d -from:me -in:sent -in:chats -category:promotions -category:social", max: 30 });
  // Which thread tasks are still open (so a reply in the same thread doesn't add the same task twice).
  const open = new Set((await hub.tasks.tasks().catch(() => [])).map((t) => t.id));
  for (const th of threads) {
    const t = await hub.gmail.getThread(th.id, th.historyId).catch(() => null);
    for (const m of t?.messages ?? []) {
      if (s.done[m.id] || new Date(m.date) < new Date(s.since)) continue;
      if (m.from.toLowerCase().includes(me) || isAutomated(m.from, "", m.subject)) {
        s.done[m.id] = [];
        continue;
      }
      if (looked >= (o.max ?? 12)) break; // keep each run small; the rest go next time
      looked++;
      const match = await matchJob(hub, m).catch(() => ({ jobNumber: undefined as number | undefined, candidates: [] }));
      const job = match.jobNumber && hub.jobs.exists(match.jobNumber) ? hub.jobs.get(match.jobNumber) : null;
      const threadOpen = (s.byThread[th.id] ?? []).filter((x) => open.has(x.id));
      const proposed = await proposeTasks(hub, m, { jobNumber: match.jobNumber, jobName: job?.name, jobStage: job?.stage, openTasks: threadOpen.map((x) => x.title) }).catch((e) => {
        hub.say(`Couldn't read "${m.subject}" for tasks: ${(e as Error).message}`);
        return null;
      });
      if (proposed === null) continue; // try again next run
      const ids: string[] = [];
      for (const p of proposed) {
        const who = m.from.replace(/<.*>/, "").trim() || m.from;
        const notes = [p.notes, `From ${who}: "${m.subject}"`, `https://mail.google.com/mail/u/0/#all/${th.id}`].filter(Boolean).join("\n");
        // Hunter's format, whatever the AI wrote: "Belvill - check in on selections" (the job number goes in the notes).
        const title = job ? jobTaskTitle(job.name, p.title) : p.title.replace(/\s*#\d{3,6}\b/g, "").trim();
        const task = await hub.tasks.create({ title, due: p.due && /^\d{4}-\d{2}-\d{2}$/.test(p.due) ? p.due : nextWorkday(), notes: job ? withJobNote(notes, job.jobNumber) : notes });
        ids.push(task.id);
        (s.byThread[th.id] ??= []).push({ listId: task.listId, id: task.id, title: task.title });
        added.push({ title: task.title, jobNumber: match.jobNumber });
        if (job) hub.jobs.log(job.jobNumber, `Task from email: ${task.title}`);
      }
      s.done[m.id] = ids;
      save(hub, s);
    }
  }
  save(hub, s);
  return added;
}
