import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { agentAsk, aiProvider, complete } from "../agent/llm.js";
import type { Task } from "../connectors/tasks/index.js";
import type { Hub } from "../hub.js";
import { generatedDrafts, withDraftSource } from "./generated.js";
import type { Reminder } from "./reminders.js";

/**
 * Keystone does what it can before the brief, so the brief is only what needs Hunter. Before each brief:
 *  - Google Tasks already done are closed: a task made from an email that Hunter has since answered.
 *  - Anything that comes down to writing an email is written by Keystone as a Gmail DRAFT: replies, proposal
 *    follow-ups, adjuster check-ins, a lead's "set up the walk" (with open times from the calendar), and tasks like
 *    "Send Eileen the photos". The task is then closed with a note saying where the draft is. Nothing is sent: the
 *    brief shows one line, "N drafts ready to send".
 *  - Homebase steps (logging a send-off, uploading files) are queued as the usual Yes/No cards, not brief lines.
 * What's left (site visits, calls, writing estimates, decisions) goes to the brief, grouped.
 *
 * Everything here runs on the free AI (Gemini) with a short, draft-only list of tools. With Claude as the everyday
 * AI it does nothing, so it never spends API money. Each run is capped (HUB_AUTOPILOT_MAX, default 10 drafts); the
 * rest are picked up by the next brief. HUB_AUTOPILOT=off turns it off.
 */
export interface Handled {
  what: string;
  jobNumber?: number;
  how: "drafted" | "closed";
  /** The reminder or task it took care of. */
  ref: { kind: Reminder["kind"] | "task"; jobNumber?: number; taskId?: string };
}
export interface AutopilotReport {
  ran: boolean;
  note?: string;
  handled: Handled[];
  /** Tasks Keystone looked at and left for Hunter, with why (so the brief can say it in a word). */
  leftForHunter: { title: string; why: string }[];
  /** How many Keystone drafts are waiting in Gmail for Hunter to send (made today or earlier). */
  draftsWaiting: number;
}

/** The only tools a handled item may use: reading the job and the mail, the calendar's free time, and making drafts. */
export const AUTOPILOT_TOOLS = ["job_get", "job_timeline", "homebase_get_job", "contacts_find", "gmail_search", "gmail_read_thread", "calendar_events", "calendar_free_time", "gmail_create_draft"];
const DRAFTABLE: Reminder["kind"][] = ["reply", "followup", "adjuster", "walk"];

interface State {
  /** key -> when it was handled; a key isn't handled twice within REDO_DAYS. */
  done: Record<string, string>;
}
const REDO_DAYS = 3;
const file = (hub: Hub) => path.join(hub.cfg.stateDir, "autopilot.json");
function load(hub: Hub): State {
  try { return existsSync(file(hub)) ? { done: {}, ...JSON.parse(readFileSync(file(hub), "utf8")) } : { done: {} }; } catch { return { done: {} }; }
}
function save(hub: Hub, s: State) {
  const cut = Date.now() - 30 * 864e5;
  for (const [k, v] of Object.entries(s.done)) if (Date.parse(v) < cut) delete s.done[k];
  mkdirSync(hub.cfg.stateDir, { recursive: true });
  writeFileSync(file(hub), JSON.stringify(s, null, 1));
}
const recently = (s: State, key: string) => !!s.done[key] && Date.now() - Date.parse(s.done[key]) < REDO_DAYS * 864e5;
const threadOf = (t: Task) => (t.notes ?? "").match(/mail\.google\.com\/mail\/u\/\d+\/#\w+\/([A-Za-z0-9]+)/)?.[1];
const jobOf = (s: string) => Number(s.match(/#(\d{4})\b/)?.[1]) || undefined;

/** Keystone drafts waiting in Gmail (not sent, not deleted). */
function openDrafts(hub: Hub) {
  return generatedDrafts(hub).filter((g) => (g.state ?? "draft") === "draft");
}

const CLASSIFY = {
  type: "object",
  properties: {
    tasks: {
      type: "array",
      items: {
        type: "object",
        properties: {
          tag: { type: "string" },
          action: { type: "string", enum: ["email", "hunter"], description: "email = the whole task is writing or answering an email (reply, send something by email, ask or tell someone something, follow up, check in). hunter = anything else: a visit, a phone call, writing or revising an estimate, ordering, a decision only Hunter can make, or anything unclear." },
          why: { type: "string", description: "a few words" },
        },
        required: ["tag", "action", "why"],
      },
    },
  },
  required: ["tasks"],
};

export async function autopilot(hub: Hub, reminders: Reminder[], o: { max?: number } = {}): Promise<AutopilotReport> {
  const report: AutopilotReport = { ran: false, handled: [], leftForHunter: [], draftsWaiting: openDrafts(hub).length };
  if ((process.env.HUB_AUTOPILOT ?? "on") === "off") return { ...report, note: "Turned off (HUB_AUTOPILOT=off)." };
  if (aiProvider(hub) !== "gemini") return { ...report, note: "Keystone only does this with the free AI (Gemini), so it never spends Claude API money." };
  report.ran = true;
  const s = load(hub);
  const max = o.max ?? (Number(process.env.HUB_AUTOPILOT_MAX) || 10);
  let drafted = 0;
  const me = hub.cfg.gmail.address.toLowerCase();
  const today = new Date().toLocaleDateString("en-CA", { timeZone: "America/Denver" });

  // ---- Google Tasks due by tomorrow
  const soon = new Date(Date.now() + 864e5).toLocaleDateString("en-CA", { timeZone: "America/Denver" });
  const tasks = hub.tasks.connected() ? (await hub.tasks.tasks().catch(() => [])).filter((t) => !t.completed && t.due && t.due <= soon) : [];
  const close = async (t: Task, note: string) => {
    await hub.tasks.update(t.listId, t.id, { completed: true, notes: [t.notes, `Handled by Keystone ${today}: ${note}`].filter(Boolean).join("\n") });
    s.done[`task:${t.id}`] = new Date().toISOString();
  };
  // 1. Already done: made from an email that Hunter has answered since.
  const open: Task[] = [];
  for (const t of tasks) {
    const th = threadOf(t);
    if (th && hub.gmail.getThread) {
      const thread = await hub.gmail.getThread(th).catch(() => null);
      const last = thread?.messages.filter((m) => !m.labelIds?.includes("DRAFT")).at(-1);
      const made = Date.parse(t.updated || "") || 0;
      if (last && last.from.toLowerCase().includes(me) && Date.parse(last.date) > made - 60_000) {
        await close(t, "you already answered that email.").catch(() => {});
        report.handled.push({ what: `Closed "${t.title}": you'd already answered the email`, jobNumber: t.jobNumber ?? jobOf(t.title), how: "closed", ref: { kind: "task", taskId: t.id } });
        continue;
      }
    }
    open.push(t);
  }
  // 2. Which of the rest are just an email.
  const tagged = open.map((t, i) => ({ t, tag: `T${i + 1}` }));
  let plan: { tag: string; action: string; why: string }[] = [];
  if (tagged.length) {
    plan = (await complete<{ tasks: typeof plan }>(hub, {
      system: "You sort an estimator's to-do list: which items are nothing more than writing an email (which an assistant can draft for him to review and send), and which need him in person. When in doubt, it needs him.",
      prompt: `Hunter Patterson is an estimator at Forefront Building + Restoration. His tasks:\n${tagged.map(({ t, tag }) => `[${tag}] ${t.title}${t.notes ? ` (${t.notes.split("\n")[0].slice(0, 200)})` : ""}`).join("\n")}`,
      schema: CLASSIFY,
      fast: true,
    }).catch(() => null))?.tasks ?? [];
  }
  const asEmail = tagged.filter(({ tag }) => plan.find((p) => p.tag === tag)?.action === "email");
  for (const { t, tag } of tagged) if (!asEmail.some((x) => x.tag === tag)) report.leftForHunter.push({ title: t.title, why: plan.find((p) => p.tag === tag)?.why ?? "needs you" });

  // ---- the drafting itself: one item at a time, draft-only tools
  const handledThreads = new Set(openDrafts(hub).map((g) => g.threadId).filter(Boolean) as string[]);
  const draftedJobs = new Set(openDrafts(hub).filter((g) => Date.now() - Date.parse(g.createdAt) < REDO_DAYS * 864e5).map((g) => g.jobNumber).filter(Boolean) as number[]);
  const draftOne = async (job: number | undefined, instruction: string): Promise<boolean> => {
    const before = new Set(generatedDrafts(hub).map((g) => g.draftId));
    const answer = await withDraftSource("Keystone (before the brief)", () => agentAsk(hub, `${instruction}

Do only this one thing. Read what you need first (the job, the email thread, the contacts). Then write the email as a Gmail DRAFT with gmail_create_draft (it is never sent; Hunter reviews and sends it). Reply inside the existing thread when there is one. If this can't be done by email, or you'd have to guess a fact, a price, a date or a promise, don't draft: reply "CAN'T: " and the reason. Otherwise reply "DRAFTED: " and one line saying who it's to and what it says.`, { jobNumber: job, tools: AUTOPILOT_TOOLS, maxSteps: 10 })).catch((e) => `CAN'T: ${(e as Error).message}`);
    const made = generatedDrafts(hub).filter((g) => !before.has(g.draftId));
    if (made.length) {
      drafted++;
      for (const g of made) { if (g.threadId) handledThreads.add(g.threadId); if (g.jobNumber) draftedJobs.add(g.jobNumber); }
      return true;
    }
    if (!/^CAN'T/i.test(answer.trim())) hub.say(`Keystone tried to draft something but didn't: ${answer.slice(0, 160)}`);
    return false;
  };

  // Reminders first (they're the money: replies and follow-ups), then email-only tasks.
  for (const r of reminders.filter((x) => DRAFTABLE.includes(x.kind))) {
    if (drafted >= max) break;
    const key = `${r.kind}:${r.jobNumber}:${r.threadId ?? ""}`;
    if (recently(s, key) || (r.threadId && handledThreads.has(r.threadId)) || (r.kind !== "reply" && draftedJobs.has(r.jobNumber))) continue;
    const instruction = {
      reply: `Job #${r.jobNumber} ${r.name}: draft Hunter's reply to the newest email in thread ${r.threadId ?? "(find it with gmail_search)"} ("${r.title}", ${r.detail}). Answer what they asked using only facts in the job, the thread and Keystone; if a question can only be answered by Hunter, say in the draft that he'll get back to them on that point.`,
      followup: `Job #${r.jobNumber} ${r.name} (${r.stage}): draft a short, friendly follow-up to the customer about the proposal Hunter sent, asking whether they have questions or are ready to move ahead. ${r.detail}`,
      adjuster: `Job #${r.jobNumber} ${r.name}: draft a short check-in to the adjuster (${r.title}). Ask where they are on their review of Forefront's estimate and whether they need anything else (photos, measurements, a call). Reply in the existing thread with them if there is one.`,
      walk: `Job #${r.jobNumber} ${r.name} is a new lead: draft an email to the customer to set up the scope walk. Offer two or three specific times from calendar_free_time over the next five weekdays (one hour each), and ask which works or what's better for them. ${r.detail ? `Address: ${r.detail}.` : ""}`,
    }[r.kind as "reply" | "followup" | "adjuster" | "walk"];
    if (await draftOne(r.jobNumber, instruction)) {
      s.done[key] = new Date().toISOString();
      report.handled.push({ what: `${{ reply: "Drafted the reply", followup: "Drafted a follow-up", adjuster: "Drafted the adjuster check-in", walk: "Drafted an email offering walk times" }[r.kind as "reply"]} for #${r.jobNumber} ${r.name}`, jobNumber: r.jobNumber, how: "drafted", ref: { kind: r.kind, jobNumber: r.jobNumber } });
    }
    save(hub, s);
  }
  for (const { t } of asEmail) {
    if (drafted >= max) { report.leftForHunter.push({ title: t.title, why: "Keystone will draft it next time (today's limit reached)" }); continue; }
    if (recently(s, `task:${t.id}`)) continue;
    const th = threadOf(t);
    if (th && handledThreads.has(th)) {
      await close(t, "the reply is already drafted in Gmail.").catch(() => {});
      report.handled.push({ what: `Closed "${t.title}": its reply is already drafted`, jobNumber: t.jobNumber ?? jobOf(t.title), how: "closed", ref: { kind: "task", taskId: t.id } });
      continue;
    }
    const ok = await draftOne(t.jobNumber ?? jobOf(t.title), `Hunter's task: "${t.title}".${t.notes ? ` Notes on it: ${t.notes.slice(0, 600)}` : ""}${th ? ` It came from Gmail thread ${th}.` : ""} Draft the email that does this task.`);
    if (ok) {
      await close(t, "drafted the email; it's in Gmail Drafts (AI drafts) for you to review and send.").catch(() => {});
      report.handled.push({ what: `Drafted "${t.title}" and closed the task`, jobNumber: t.jobNumber ?? jobOf(t.title), how: "drafted", ref: { kind: "task", taskId: t.id } });
    } else report.leftForHunter.push({ title: t.title, why: "couldn't be done by email alone" });
    save(hub, s);
  }
  save(hub, s);
  report.draftsWaiting = openDrafts(hub).length;
  return report;
}

/** The autopilot's work as a paragraph for the brief's instructions. */
export function autopilotNote(r: AutopilotReport): string {
  const lines = [`Keystone has already handled what it could before this brief${r.ran ? "" : ` (${r.note ?? "skipped"})`}:`];
  if (r.handled.length) lines.push(...r.handled.map((h) => `- ${h.what}`));
  else lines.push("- (nothing this time)");
  lines.push(`Keystone drafts waiting in Gmail for Hunter to review and send: ${r.draftsWaiting}.`);
  if (r.leftForHunter.length) lines.push(`Tasks Keystone left for Hunter: ${r.leftForHunter.map((t) => `"${t.title}" (${t.why})`).join("; ")}.`);
  return lines.join("\n");
}
