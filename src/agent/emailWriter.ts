import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import type { Job } from "../core/job.js";
import type { Hub } from "../hub.js";
import { TemplateWriter, type EmailContext, type EmailWriter, type Pick, type PhotoInfo } from "../workflows/writer.js";
import { aiReady, claudeOnlyReady, complete } from "./llm.js";

/**
 * The send-off writer. The email text is easy work, so it goes to the everyday AI (Gemini, free), following the
 * skill's own step 6 (voice, subjects, variants) read straight from SKILL.md, so the rules still live only in the
 * skill. Picking the adjuster's report photos means looking at the photos with the estimating skill, so that
 * stays on Claude (when there's an Anthropic key). Either part falls back to the plain template.
 */
export class SendoffWriter implements EmailWriter {
  private template = new TemplateWriter();
  constructor(private hub: Hub) {}

  async writeEmail(ctx: EmailContext) {
    if (!aiReady(this.hub)) {
      this.hub.say("Using plain template wording (no AI key on this machine).");
      return this.template.writeEmail(ctx);
    }
    const { job, kind } = ctx;
    const rules = skillStep6(this.hub.cfg.skillDir);
    const estimate = readEstimate(this.hub, job.jobNumber);
    const addr = kind === "homeowner" ? job.customer.email : job.adjuster.email;
    const earlier = addr ? await this.hub.gmail.search(`to:${addr} OR from:${addr}`, 5).catch(() => []) : [];
    const r = await complete<{ subject: string; body: string }>(this.hub, {
      system: `You write Hunter Patterson's estimate send-off emails for Forefront Building + Restoration. Follow these rules from Forefront's estimating skill exactly (subject format, voice, the right variant):\n\n${rules}`,
      prompt: `Write the ${kind} send-off email for job #${job.jobNumber} (${job.name}, ${job.address}), insurance status "${job.insurance}".
Facts: ${JSON.stringify({ customer: job.customer, adjuster: job.adjuster, carrier: job.carrier, claimNumber: job.claimNumber, dateOfLoss: job.dateOfLoss, total: ctx.total, xactimateTotal: ctx.xactimateTotal, priceList: ctx.priceList, attachments: ctx.attachments })}
${estimate ? `The estimate (for the scope the adjuster summary needs): ${estimate}` : ""}
${earlier.length ? `Earlier emails with this person (match what was already said; don't repeat it): ${JSON.stringify(earlier.map((t) => ({ subject: t.subject, snippet: t.snippet })))}` : ""}
Return only the subject and the plain-text body (paragraphs separated by blank lines). No signature: Gmail adds Hunter's. Never invent numbers or facts not given here.`,
      schema: { type: "object", properties: { subject: { type: "string" }, body: { type: "string" } }, required: ["subject", "body"] },
    });
    if (!r?.subject || !r?.body) throw new Error("The AI didn't return an email. Try again, or use the template.");
    return r;
  }

  async pickPhotos(job: Job, photos: PhotoInfo[], photosDir: string): Promise<Pick[]> {
    if (!claudeOnlyReady(this.hub)) return this.template.pickPhotos(job, photos);
    const { AgentWriter } = await import("./writer.js");
    return new AgentWriter(this.hub).pickPhotos(job, photos, photosDir);
  }
}

/** The skill's "6. Send-off email" section (up to the next top-level section). */
export function skillStep6(skillDir: string): string {
  const f = path.join(skillDir, "SKILL.md");
  if (!existsSync(f)) return "Warm, short plain paragraphs in Hunter's voice; no bullet points; close with \"Thanks,\".";
  const md = readFileSync(f, "utf8");
  const m = md.match(/^## 6\.[^\n]*\n[\s\S]*?(?=^## (?!6\.)|(?![\s\S]))/m);
  return (m?.[0] ?? md).trim();
}

function readEstimate(hub: Hub, n: number): string {
  const f = hub.jobs.path(n, "estimate", "estimate.json");
  if (!existsSync(f)) return "";
  const s = readFileSync(f, "utf8");
  return s.length > 15000 ? `${s.slice(0, 15000)}…(cut)` : s;
}
