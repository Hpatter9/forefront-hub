import { query } from "@anthropic-ai/claude-agent-sdk";
import { aiReady, complete } from "./llm.js";
import { confirmText } from "../core/approval.js";
import type { Hub } from "../hub.js";

/**
 * After an email goes out or a call is logged, Claude writes a one-line note for the job's Homebase feed. Hunter sees
 * it (and can edit it) before it is posted; nothing is posted without his OK.
 */
export interface NoteEvent {
  kind: "email" | "call" | "send-off";
  /** What happened, in plain words: the email's recipients, subject and body, or the call notes. */
  text: string;
}

export async function draftNote(hub: Hub, jobNumber: number, e: NoteEvent): Promise<string | null> {
  if (!aiReady(hub)) return null;
  const job = hub.jobs.exists(jobNumber) ? hub.jobs.get(jobNumber) : null;
  const prompt = `Write ONE line (under 200 characters) for the Notes feed of Homebase job #${jobNumber}${job ? ` (${job.name}, ${job.address})` : ""}, saying what just happened so anyone at Forefront Building + Restoration can follow the job. Write it the way an estimator jots a job note: past tense, plain, who and what, the dollar figure or next step when there is one. No greeting, no quotes, no sign-off.

What happened (${e.kind}):
${e.text.slice(0, 6000)}`;
  const out = await complete<string>(hub, { system: "You write short, factual job notes for a restoration contractor's CRM.", prompt });
  return out.trim().replace(/^["']|["']$/g, "").split("\n")[0] || null;
}

/** One or two sentences on a day's text conversation with someone on a job, for the Homebase notes feed. */
export async function draftTextSummary(hub: Hub, p: { jobNumber: number; name: string; day: string; who: string; role: string; texts: { fromMe: boolean; text: string }[] }): Promise<string> {
  if (!aiReady(hub)) return "";
  const first = p.who.split(/\s+/)[0];
  const out = await complete<string>(hub, {
    system: "You write short, factual job notes for a restoration contractor's CRM.",
    fast: true,
    prompt: `Summarize this day's text conversation between Hunter (the estimator) and ${p.who} (${p.role}) on job #${p.jobNumber} ${p.name}, for the job's Notes feed in Homebase. One or two plain sentences, past tense: what it was about, anything agreed (dates, amounts, choices), and the next step if there is one. Don't quote the texts, don't add anything that isn't in them, no greeting.

${p.texts.map((t) => `${t.fromMe ? "Hunter" : first}: ${t.text}`).join("\n").slice(0, 6000)}`,
  });
  return out.trim().replace(/^["']|["']$/g, "").replace(/\s*\n+\s*/g, " ");
}

/** Drafts the note, asks Hunter (editable), and posts it to Homebase if he says yes. */
export async function suggestNote(hub: Hub, jobNumber: number, e: NoteEvent): Promise<boolean> {
  let text: string | null;
  try {
    text = await draftNote(hub, jobNumber, e);
  } catch (err) {
    hub.say(`Couldn't draft a note: ${(err as Error).message}`);
    return false;
  }
  if (!text) return false;
  const final = await confirmText(hub.approver, `Add this note to Homebase #${jobNumber}?`, ["Claude wrote it from what just happened. Edit it if you like."], text);
  if (!final) return false;
  await hub.homebase.addNote(jobNumber, { kind: "note", body: final });
  if (hub.jobs.exists(jobNumber)) hub.jobs.log(jobNumber, `Homebase note: ${final}`);
  hub.say(`Added the note to Homebase #${jobNumber}.`);
  return true;
}
