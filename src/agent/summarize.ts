import { query } from "@anthropic-ai/claude-agent-sdk";
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
  if (!hub.cfg.anthropicApiKey) return null;
  const job = hub.jobs.exists(jobNumber) ? hub.jobs.get(jobNumber) : null;
  const prompt = `Write ONE line (under 200 characters) for the Notes feed of Homebase job #${jobNumber}${job ? ` (${job.name}, ${job.address})` : ""}, saying what just happened so anyone at Forefront Building + Restoration can follow the job. Write it the way an estimator jots a job note: past tense, plain, who and what, the dollar figure or next step when there is one. No greeting, no quotes, no sign-off.

What happened (${e.kind}):
${e.text.slice(0, 6000)}`;
  let out = "";
  for await (const m of query({
    prompt,
    options: {
      model: hub.cfg.model,
      maxTurns: 1,
      allowedTools: [],
      settingSources: [],
      canUseTool: async () => ({ behavior: "deny", message: "No tools for a note." }),
      systemPrompt: "You write short, factual job notes for a restoration contractor's CRM.",
      env: { ...(process.env as Record<string, string>), ANTHROPIC_API_KEY: hub.cfg.anthropicApiKey },
    },
  })) {
    if (m.type === "result" && m.subtype === "success") out = m.result;
  }
  return out.trim().replace(/^["']|["']$/g, "").split("\n")[0] || null;
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
