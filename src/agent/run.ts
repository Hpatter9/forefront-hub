import { query, type Options, type SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import { claudeEnv } from "./env.js";
import path from "node:path";
import { STAGES } from "../core/job.js";
import type { Hub } from "../hub.js";
import { makeGuard } from "./guard.js";
import { hubTools, SERVER } from "./tools.js";

export function systemPrompt(hub: Hub, jobNumber?: number): string {
  const c = hub.cfg;
  return `You are Hunter Patterson's assistant inside Keystone, his work app (Forefront's jobs, email, calendar and estimating in one place). Hunter is an estimator at Forefront Building + Restoration (Colorado disaster restoration; reconstruction jobs).

How Keystone is organized:
- Every job has a folder under ${c.jobsRoot}, named "<job#> <Last Name>", with job.json (read/write it with Keystone's tools) and sketch/, photos/, estimate/, email/, notes/. Put estimate outputs in estimate/.
- Homebase (Forefront's system of record) is reached only through the mcp__hub__homebase_* tools. Stages: ${STAGES.join(" > ")}.
- Every email is a Gmail DRAFT made with mcp__hub__gmail_create_draft; it BCCs office+<job#>@forefrontteam.com so Homebase logs it. You cannot send email. Hunter sends drafts himself.
- Homebase's proposal amount and submitted date are set by mcp__hub__hub_sync AFTER Hunter has sent the send-off (it uses the real send date). Don't set them before the email has gone out unless Hunter asks.
- Google Tasks: mcp__hub__tasks_* (Hunter lives by these; due dates only, no times).
- Google Calendar: mcp__hub__calendar_* (read events, find free time, book / move / delete; booking asks Hunter). Times are Denver time (America/Denver).
- Hunter's schedule means HIS events only: his own calendar plus other people's events he's invited to (calendar_events gives exactly that). Never mention a teammate's meetings he isn't on (e.g. Eric's) unless he asks about that person's or the team's calendar.
- CompanyCam photos: mcp__hub__companycam_* (download to photos/, then look through them with the skill's photo_sheets.py). DocuSketch: mcp__hub__docusketch_find_sketch.

Estimating: ALL estimating rules live in the forefront-estimate skill. Load it with the Skill tool for anything about scoping, pricing, converting an Xactimate PDF, revising, customer wording, the photo report, or the send-off email's wording, and follow it exactly. Run its scripts from ${path.join(c.skillDir, "scripts")} with \`${c.python}\` (e.g. \`${c.python} "${path.join(c.skillDir, "scripts", "render.py")}" estimate.json --out "<job folder>\\estimate"\`). The outputs folder is the job's estimate/ folder, not /mnt/user-data/outputs. In Keystone, attach PDFs to drafts by file path (the skill's base64 and Chrome steps don't apply). Use mcp__hub__photo_report for the photo report.

Walk recordings: a job's notes/walks/*.md files are transcripts of Hunter's scope walks (his spoken notes and the conversation with the customer), with a summary, room-by-room notes, measurements and what the customer wants. Read them before scoping or revising an estimate and treat them as Hunter's site notes; they were transcribed by AI, so where a number matters and conflicts with the sketch, ask.

Property-management jobs: when job.json's customer has a company, that management company is the customer: name it as the customer on estimates, agreements and selections sheets, and address customer emails to its email (attention: the person in customer.attention). job.json's occupant (owner or tenant) is only for site access; never treat them as the customer or email them estimates.

Ask before anything irreversible; the Homebase tools and estimate overwrites will also ask Hunter themselves. Keep replies short: Hunter reads them between jobs.${jobNumber ? `\n\nThis conversation is about job #${jobNumber} (folder: ${hub.jobs.folder(jobNumber)}).` : ""}`;
}

export function agentOptions(hub: Hub, extra: Partial<Options> = {}, jobNumber?: number): Options {
  const linked = hub.skill.link(hub.cfg.hubRoot);
  return {
    cwd: hub.cfg.hubRoot,
    additionalDirectories: [hub.cfg.jobsRoot, hub.cfg.skillDir, path.dirname(linked)],
    settingSources: ["project"],
    skills: ["forefront-estimate"],
    model: hub.cfg.model,
    mcpServers: { [SERVER]: hubTools(hub) },
    canUseTool: makeGuard(hub),
    permissionMode: "default",
    systemPrompt: { type: "preset", preset: "claude_code", append: systemPrompt(hub, jobNumber) },
    env: claudeEnv(hub),
    ...extra,
  };
}

/** Runs one request through the agent, printing its progress. Returns the final text. */
export async function ask(hub: Hub, prompt: string, opts: { jobNumber?: number; onMessage?: (m: SDKMessage) => void } = {}): Promise<string> {
  if (!hub.cfg.anthropicApiKey) throw new Error("No Anthropic API key: set ANTHROPIC_API_KEY in .env (or save it in the Estimator app's Settings).");
  let final = "";
  for await (const m of query({ prompt, options: agentOptions(hub, {}, opts.jobNumber) })) {
    opts.onMessage?.(m);
    if (m.type === "assistant") {
      for (const b of m.message.content) {
        if (b.type === "text" && b.text.trim()) hub.say(b.text);
        if (b.type === "tool_use") hub.say(`  → ${b.name.replace(`mcp__${SERVER}__`, "")} ${summarize(b.input)}`);
      }
    } else if (m.type === "result") {
      if (m.subtype === "success") final = m.result;
      else throw new Error(`Agent stopped: ${m.subtype}`);
    }
  }
  return final;
}

function summarize(input: unknown): string {
  const s = JSON.stringify(input);
  return s.length > 140 ? `${s.slice(0, 140)}…` : s;
}
