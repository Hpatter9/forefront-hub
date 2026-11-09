import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import type { Job } from "../core/job.js";
import type { Hub } from "../hub.js";
import { TemplateWriter, type EmailContext, type EmailWriter, type Pick, type PhotoInfo } from "../workflows/writer.js";
import { aiProvider, aiReady, complete } from "./llm.js";

/**
 * The send-off writer. The email text is easy work, so it goes to the everyday AI (Gemini, free), following the
 * skill's own step 6 (voice, subjects, variants) read straight from SKILL.md, so the rules still live only in the
 * skill. The adjuster's report photos are picked by Gemini too: it looks at the skill's own contact sheets
 * (photo_sheets.py) and follows the skill's photo report rules. Either part falls back to the plain template;
 * nothing here uses the paid Claude API.
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
    if (aiProvider(this.hub) !== "gemini") {
      this.hub.say("Photo report: using the first photos in order (no Gemini key on this machine).");
      return this.template.pickPhotos(job, photos);
    }
    // The skill's contact sheets: 12 numbered thumbnails each, numbered in the order the files are given.
    const tmp = mkdtempSync(path.join(os.tmpdir(), "keystone-sheets-"));
    try {
      const files = photos.map((p) => path.join(photosDir, p.file)).filter((f) => existsSync(f));
      const r = await this.hub.skill.run("photo_sheets.py", [...files, "--out", tmp]);
      if (r.code !== 0) throw new Error(`photo_sheets.py failed: ${r.stderr || r.stdout}`);
      const skipped = new Set([...r.stderr.matchAll(/^! skipped (.+?):/gm)].map((m) => m[1]));
      const numbered = files.map((f) => path.basename(f)).filter((n) => !skipped.has(n)); // #1 is numbered[0]
      const sheets = readdirSync(tmp).filter((f) => /^sheet_\d+\.jpg$/.test(f)).sort().slice(0, 12);
      const info = new Map(photos.map((p) => [p.file, p]));
      const out = await complete<{ photos: { number: number; caption: string; room?: string }[] }>(this.hub, {
        system: `You pick photos for Forefront Building + Restoration's adjuster photo report. Follow these rules from Forefront's estimating skill:\n\n${skillStep6(this.hub.cfg.skillDir)}`,
        prompt: `Job #${job.jobNumber}, ${job.address}${job.claimNumber ? `, claim ${job.claimNumber}` : ""}. The attached contact sheets show ${numbered.length} numbered photos (#1 to #${numbered.length}).
CompanyCam details by number: ${JSON.stringify(numbered.map((n, i) => ({ number: i + 1, description: info.get(n)?.description || undefined, taken: info.get(n)?.capturedAt || undefined })))}
${readEstimate(this.hub, job.jobNumber, 8000) ? `The estimate (the scope the photos have to justify): ${readEstimate(this.hub, job.jobNumber, 8000)}` : ""}
Pick the 6 to 12 photos that best justify the scope, in a logical order (overview, damage, extent of removal, before-loss finishes). For each give its number, one plain adjuster-facing caption describing only what the photo shows, and the room. Don't pick near-duplicates or blurry photos.`,
        images: sheets.map((f) => ({ mimeType: "image/jpeg", data: readFileSync(path.join(tmp, f)).toString("base64") })),
        schema: {
          type: "object",
          properties: { photos: { type: "array", items: { type: "object", properties: { number: { type: "integer" }, caption: { type: "string" }, room: { type: "string" } }, required: ["number", "caption"] } } },
          required: ["photos"],
        },
      });
      const seen = new Set<string>();
      const picks: Pick[] = [];
      for (const p of out?.photos ?? []) {
        const file = numbered[p.number - 1];
        if (!file || seen.has(file)) continue;
        seen.add(file);
        picks.push({ file, caption: p.caption, ...(p.room ? { room: p.room } : {}) });
      }
      if (!picks.length) throw new Error("Gemini didn't pick any photos for the report. Try again.");
      return picks;
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
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

function readEstimate(hub: Hub, n: number, max = 15000): string {
  const f = hub.jobs.path(n, "estimate", "estimate.json");
  if (!existsSync(f)) return "";
  const s = readFileSync(f, "utf8");
  return s.length > max ? `${s.slice(0, max)}…(cut)` : s;
}
