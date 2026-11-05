import { query } from "@anthropic-ai/claude-agent-sdk";
import type { Job } from "../core/job.js";
import type { Hub } from "../hub.js";
import type { EmailContext, EmailWriter, Pick, PhotoInfo } from "../workflows/writer.js";
import { agentOptions } from "./run.js";

/**
 * The send-off's judgment calls, made by Claude with the forefront-estimate skill loaded, so the wording and the
 * photo choices follow the skill (step 6) rather than anything hard-coded here. Read-only: it may look at files and
 * search Gmail for the thread, but it creates nothing; the send-off workflow makes the drafts.
 */
export class AgentWriter implements EmailWriter {
  constructor(private hub: Hub) {}

  private async json<T>(prompt: string, schema: Record<string, unknown>, jobNumber: number): Promise<T> {
    const opts = agentOptions(this.hub, {
      outputFormat: { type: "json_schema", schema },
      allowedTools: ["Skill", "Read", "Glob", "Grep", "mcp__hub__job_get", "mcp__hub__gmail_search", "mcp__hub__gmail_read_thread", "mcp__hub__estimate_status", "Bash"],
      disallowedTools: ["Write", "Edit", "mcp__hub__gmail_create_draft", "mcp__hub__homebase_set_proposal", "mcp__hub__homebase_set_stage", "mcp__hub__homebase_add_note", "mcp__hub__hub_sync"],
      maxTurns: 30,
    }, jobNumber);
    for await (const m of query({ prompt, options: opts })) {
      if (m.type === "assistant") for (const b of m.message.content) if (b.type === "tool_use") this.hub.say(`  → ${b.name}`);
      if (m.type === "result") {
        if (m.subtype !== "success") throw new Error(`Writer stopped: ${m.subtype}`);
        if (m.structured_output) return m.structured_output as T;
        const raw = m.result.match(/\{[\s\S]*\}/)?.[0];
        if (raw) return JSON.parse(raw) as T;
        throw new Error("Writer returned no JSON");
      }
    }
    throw new Error("Writer ended without a result");
  }

  async writeEmail(ctx: EmailContext) {
    const { job, kind } = ctx;
    return this.json<{ subject: string; body: string }>(
      `Write the ${kind} send-off email for job #${job.jobNumber} (${job.name}, ${job.address}) following the forefront-estimate skill's step 6 exactly: subject format, Hunter's voice, the right variant for ${kind} with insurance status "${job.insurance}".
Facts: ${JSON.stringify({ customer: job.customer, adjuster: job.adjuster, carrier: job.carrier, claimNumber: job.claimNumber, dateOfLoss: job.dateOfLoss, total: ctx.total, xactimateTotal: ctx.xactimateTotal, priceList: ctx.priceList, attachments: ctx.attachments })}
Read the estimate.json in the job's estimate/ folder for the scope logic the adjuster summary needs. If there's an earlier email thread with this ${kind} (search Gmail for the address), match what was already said and don't repeat it.
Return only the subject and the plain-text body (paragraphs separated by blank lines). No signature: Gmail adds Hunter's.`,
      { type: "object", properties: { subject: { type: "string" }, body: { type: "string" } }, required: ["subject", "body"], additionalProperties: false },
      job.jobNumber,
    );
  }

  async pickPhotos(job: Job, photos: PhotoInfo[], photosDir: string): Promise<Pick[]> {
    const r = await this.json<{ photos: Pick[] }>(
      `Pick the photos for the adjuster's photo report for job #${job.jobNumber} (${job.address}) per the forefront-estimate skill (step 6, "Photo report"): the 6–12 photos that justify the scope, in a logical order (overview, damage, extent of removal, before-loss finishes), each with one plain adjuster-facing caption and the room.
The photos are in ${photosDir} (CompanyCam dates/descriptions: ${JSON.stringify(photos)}). Make contact sheets first with the skill's photo_sheets.py (--out to a temp folder) and look at them; open single photos only where you need detail. Use the estimate in the job's estimate/ folder to know what the scope is.
Return the picks with "file" exactly as the file name in the photos folder.`,
      {
        type: "object",
        properties: {
          photos: {
            type: "array",
            items: { type: "object", properties: { file: { type: "string" }, caption: { type: "string" }, room: { type: "string" } }, required: ["file", "caption"], additionalProperties: false },
          },
        },
        required: ["photos"],
        additionalProperties: false,
      },
      job.jobNumber,
    );
    const names = new Set(photos.map((p) => p.file));
    const picks = r.photos.filter((p) => names.has(p.file));
    if (!picks.length) throw new Error("The writer picked no photos that exist in the photos folder.");
    return picks;
  }
}
