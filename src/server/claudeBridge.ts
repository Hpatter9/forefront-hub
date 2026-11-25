import { existsSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { z } from "zod";
import { estimatorTools, runPython } from "../agent/geminiEstimator.js";
import type { Approver } from "../core/approval.js";
import type { Hub } from "../hub.js";
import { jobDossier } from "../workflows/dossier.js";
import { checkEstimate, checkText } from "../workflows/estimateCheck.js";
import { pullJob } from "../workflows/pull.js";

/**
 * Keystone's tools for the Claude desktop app, so estimates are written there on Hunter's subscription instead of
 * through the paid API. The Claude app starts a tiny helper (mcpb/server/index.cjs) that passes each tool call to the
 * running Keystone over 127.0.0.1; this file is what answers. Claude brings the model and Hunter's estimating
 * skill; Keystone brings the job (its files, photos, emails, texts, walk notes), the skill's scripts and price
 * book on this PC, and the free check afterwards. Results are saved straight into the job folder: nothing is
 * dragged in or out.
 *
 * The same limits as the Estimator's other writers: reads stay in the job folder and the skill, writes stay in
 * the job folder, only the skill's own scripts run. Replacing an estimate keeps the old version in
 * estimate/revisions; the yes/no for it is the Claude app's own "allow this tool?" prompt, since Hunter is in
 * that window, not Keystone's.
 */
export interface BridgeTool {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}
export type BridgeContent = { type: "text"; text: string } | { type: "image"; data: string; mimeType: string };
export interface BridgeResult {
  content: BridgeContent[];
  isError?: boolean;
}

/** Hunter approves tool calls in the Claude app, so Keystone doesn't ask a second time in another window. */
class AppApproves implements Approver {
  constructor(private say: (t: string) => void) {}
  async confirm(question: string) {
    this.say(`Claude app: ${question.replace(/\?.*$/, "")} (allowed in the Claude app; the old version is kept).`);
    return true;
  }
}

const job = z.number().int().describe("Keystone's job number, e.g. 3184");
const schema = (shape: Record<string, z.ZodType>) => {
  const s = z.toJSONSchema(z.object(shape), { unrepresentable: "any" }) as Record<string, unknown>;
  delete s.$schema;
  return s;
};

export const BRIDGE_INSTRUCTIONS = `Keystone is Hunter Patterson's job hub at Forefront Building + Restoration, running on his computer. These tools reach the job folders, the estimating skill's scripts and Forefront's price book on that computer.

To write or revise an estimate: call keystone_start_estimate with the job number first. It returns how to work, the estimating skill's instructions, and everything on the job. Run the skill's scripts with keystone_run_script (they run on Hunter's computer, where the job files and price book are), never in your own sandbox, and save results with keystone_write_file / render.py into the job folder. When the documents are rendered, call keystone_check_estimate and tell Hunter what it found.`;

export function bridge(hub: Hub) {
  // The same hub, with the Claude app standing in for Keystone's yes/no card.
  const tools = (n: number) => estimatorTools({ ...hub, approver: new AppApproves((t) => hub.say(t)) }, n);
  const ensure = async (n: number) => { if (!hub.jobs.exists(n)) await pullJob(hub, n, { quiet: true }); };
  const text = (t: string): BridgeResult => ({ content: [{ type: "text", text: t }] });

  const defs: { tool: BridgeTool; run: (a: any) => Promise<BridgeResult> }[] = [
    {
      tool: { name: "keystone_find_job", description: "Find a job by customer name, street or job number. Returns matching jobs with their number, name, address and stage.", inputSchema: schema({ query: z.string() }) },
      run: async ({ query }) => {
        const q = String(query ?? "").toLowerCase().replace(/#/g, "").trim();
        const words = q.split(/\s+/).filter(Boolean);
        let list = hub.jobs.list().map((j) => ({ jobNumber: j.jobNumber, name: j.name, address: j.address, stage: j.stage }));
        const hit = (j: { jobNumber: number; name: string; address: string }) => words.every((w) => `${j.jobNumber} ${j.name} ${j.address}`.toLowerCase().includes(w));
        if (!list.some(hit)) list = [...list, ...(await hub.homebase.listJobs({ openOnly: true }).catch(() => [])).map((j) => ({ jobNumber: j.jobNumber, name: j.name, address: j.address ?? "", stage: j.stage ?? "" }))];
        const found = list.filter(hit).slice(0, 12);
        return text(found.length ? JSON.stringify(found) : `No job matches "${query}". Ask Hunter for the job number.`);
      },
    },
    {
      tool: { name: "keystone_start_estimate", description: "START HERE for any estimate, agreement, selections sheet, photo report or revision. Returns how to work with Keystone's tools, Forefront's estimating skill (SKILL.md) as it is on Hunter's computer, and everything on the job: files, DocuSketch files, photo sheets and notes, a digest of the emails, texts and calls, walk transcripts, team notes, and what's missing.", inputSchema: schema({ jobNumber: job }) },
      run: async ({ jobNumber: n }) => {
        await ensure(n);
        const skill = existsSync(path.join(hub.cfg.skillDir, "SKILL.md")) ? readFileSync(path.join(hub.cfg.skillDir, "SKILL.md"), "utf8") : "";
        // Don't make the Claude app wait on the free AI: use the digest if it's saved, and build it for next time.
        // ITEL reports are looked for in the job's email first (quick; summaries are made after if new).
        await (await import("../workflows/itel.js")).fetchItelReports(hub, n).catch(() => []);
        const review = await jobDossier(hub, n, { cachedOnly: true });
        void jobDossier(hub, n).catch(() => {});
        return text([
          `# How to work on job #${n} from the Claude app`,
          `- You are writing in the Claude app on Hunter's subscription. Keystone's tools reach his computer: the job folder, the estimating skill's scripts and the price book.`,
          `- Follow the skill below exactly. Where it says to run a script ("python scripts/x.py ..."), call keystone_run_script with script "x.py" and the same arguments as a list; paths are relative to the job folder ("estimate/estimate.json", "--out", "estimate"). Do not run the skill's scripts in your own sandbox: the job's files and the price book aren't there.`,
          `- Read files with keystone_read_file (the skill's references are "skill/references/..."), PDFs with keystone_pdf_text, photos and contact sheets with keystone_view_photos. Write estimate.json and any picks file with keystone_write_file. Prices come only from price_lookup.py.`,
          `- ITEL reports: the job's are listed under "itel" below and saved in files/ITEL. Read each PDF with keystone_pdf_text before using it and follow the skill's "ITEL pricing" rule: a report applies only to the material and rooms it covers. Tell Hunter which lines you priced from which report.`,
          `- Measurements come from DocuSketch's floor plans (its PDF and measurement images) and the walk transcript. DocuSketch's .ESX is encrypted and can't be read: don't try it or ask for one.`,
          `- Go through what's below before you scope: the "conversation" digest (open an original email only where a point decides scope, quantity or price), the walk transcripts and notes, and the photo sheets for the rooms in the scope. Tell Hunter in a few lines what you went through, what changes the scope, what conflicts and what's missing, then ask the skill's questions before pricing.`,
          `- When the documents are rendered they are already in the job's estimate folder; Hunter sees them in Keystone. Call keystone_check_estimate and report what it found.`,
          `- Email: when he asks for the send-off (or any email), write it per the skill's step 6 and make it with keystone_create_draft, attaching the PDFs from estimate/. It's only a Gmail draft; he sends it. Skip the skill's base64 steps and any other Gmail connector: this one BCCs the Homebase log and attaches the files from his computer.`,
          ``,
          `# The forefront-estimate skill (SKILL.md on Hunter's computer)`,
          skill || "(SKILL.md wasn't found on this computer; use your installed forefront-estimate skill.)",
          ``,
          `# Everything on the job`,
          JSON.stringify(review),
        ].join("\n"));
      },
    },
    {
      tool: { name: "keystone_list_files", description: "List the files in a folder of the job (\"\" for the job folder: sketch, photos, estimate, files, notes, email) or of the skill (\"skill/references\", \"skill/scripts\").", inputSchema: schema({ jobNumber: job, dir: z.string().default("") }) },
      run: async ({ jobNumber: n, dir }) => { await ensure(n); return text((await tools(n).run("list_files", { dir: dir ?? "" })).result); },
    },
    {
      tool: { name: "keystone_read_file", description: "Read a text file (md, txt, json, csv) from the job folder or the skill (\"skill/references/scoping_guide.md\"). Up to 40,000 characters per call; pass offset to continue. Use keystone_pdf_text for PDFs and keystone_view_photos for images.", inputSchema: schema({ jobNumber: job, path: z.string(), offset: z.number().int().min(0).default(0) }) },
      run: async ({ jobNumber: n, path: p, offset }) => { await ensure(n); return text((await tools(n).run("read_file", { path: p, offset: offset ?? 0 })).result); },
    },
    {
      tool: { name: "keystone_pdf_text", description: "Read the text of a PDF in the job folder (an adjuster's estimate, a report, DocuSketch's measurement PDF). For an Xactimate estimate use keystone_run_script read_xactimate.py instead.", inputSchema: schema({ jobNumber: job, path: z.string() }) },
      run: async ({ jobNumber: n, path: p }) => {
        await ensure(n);
        const root = hub.jobs.folder(n), f = path.resolve(root, String(p));
        const rel = path.relative(root, f);
        if (rel.startsWith("..") || path.isAbsolute(rel)) return { ...text("Only files in this job's folder can be read."), isError: true };
        if (!existsSync(f) || !/\.pdf$/i.test(f)) return { ...text("No such PDF. Use keystone_list_files to see what's there."), isError: true };
        return text(await runPython(hub, path.join(hub.cfg.hubRoot, "scripts", "pdf_text.py"), [f], root));
      },
    },
    {
      tool: { name: "keystone_view_photos", description: "Look at up to 4 images from the job folder: the numbered contact sheets (photos/sheets/sheet_01.jpg), a CompanyCam preview, a single photo, a DocuSketch room image. Prefer contact sheets over single photos.", inputSchema: schema({ jobNumber: job, paths: z.array(z.string()).min(1).max(4) }) },
      run: async ({ jobNumber: n, paths }) => {
        await ensure(n);
        const images = (paths as string[]).filter((p) => !/\.pdf$/i.test(p));
        if (!images.length) return text("Those are PDFs: use keystone_pdf_text.");
        const r = await tools(n).run("view_files", { paths: images });
        const big = (r.media ?? []).filter((m) => m.data.length > 2_800_000).length;
        return { content: [{ type: "text", text: `${r.result}${big ? `\n${big} image${big === 1 ? " was" : "s were"} too large to show here: use the contact sheets or photos/previews instead.` : ""}` }, ...(r.media ?? []).filter((m) => m.mimeType.startsWith("image/") && m.data.length <= 2_800_000).map((m) => ({ type: "image" as const, data: m.data, mimeType: m.mimeType }))] };
      },
    },
    {
      tool: { name: "keystone_write_file", description: "Write a text file inside the job folder (estimate/estimate.json, a picks JSON for the photo report, notes). Replacing estimate.json keeps the old version in estimate/revisions.", inputSchema: schema({ jobNumber: job, path: z.string(), content: z.string() }) },
      run: async ({ jobNumber: n, path: p, content }) => { await ensure(n); return text((await tools(n).run("write_file", { path: p, content })).result); },
    },
    {
      tool: { name: "keystone_run_script", description: "Run one of the estimating skill's scripts on Hunter's computer, from the job folder: read_xactimate.py, price_lookup.py, render.py, photo_sheets.py, photo_report.py. Arguments as a list, exactly as the skill shows them; file paths relative to the job folder. Returns what the script printed. Re-rendering keeps the old estimate in estimate/revisions.", inputSchema: schema({ jobNumber: job, script: z.string(), args: z.array(z.string()).default([]) }) },
      run: async ({ jobNumber: n, script, args }) => { await ensure(n); return text((await tools(n).run("run_script", { script, args: args ?? [] })).result); },
    },
    {
      tool: { name: "keystone_check_estimate", description: "Keystone's check of the job's estimate after it's written or changed: every unit price against the job's price list and Forefront's price book, quantities against the room sizes, plain slips, and the scope against the walk notes, emails and texts. Run it after rendering and tell Hunter what it found.", inputSchema: schema({ jobNumber: job }) },
      run: async ({ jobNumber: n }) => {
        await ensure(n);
        const c = await checkEstimate(hub, n);
        return text(c ? checkText(c).replace("(free, no Claude used)", "") : "There's no estimate.json in this job's estimate folder yet.");
      },
    },
    {
      tool: { name: "keystone_estimate_files", description: "What's in the job's estimate folder right now (the PDFs, estimate.json, how many earlier versions are kept), so you can tell Hunter what was written.", inputSchema: schema({ jobNumber: job }) },
      run: async ({ jobNumber: n }) => {
        await ensure(n);
        const dir = hub.jobs.path(n, "estimate");
        const files = hub.jobs.files(n, "estimate", /\.(pdf|json)$/i).map((f) => ({ name: path.basename(f), kb: Math.max(1, Math.round(statSync(f).size / 1024)), modified: statSync(f).mtime.toISOString() }));
        return text(JSON.stringify({ folder: dir, files }));
      },
    },
    {
      tool: { name: "keystone_create_draft", description: "Make a Gmail DRAFT in Hunter's mailbox (never sent: he reviews and sends it). For the estimate send-off use kind 'homeowner' or 'adjuster' (Keystone then logs the proposal in Homebase once he sends it); 'other' for anything else. Attachments are paths in the job folder, e.g. \"estimate/Smith - Reconstruction Estimate.pdf\". The job's Homebase log address is BCC'd and his signature is added automatically. threadId replies inside an existing email thread.", inputSchema: schema({ jobNumber: job, kind: z.enum(["homeowner", "adjuster", "other"]).default("other"), to: z.array(z.string()).min(1), cc: z.array(z.string()).default([]), subject: z.string(), body: z.string(), attachments: z.array(z.string()).default([]), threadId: z.string().optional() }) },
      run: async (a) => { await ensure(a.jobNumber); return text((await tools(a.jobNumber).run("gmail_create_draft", a)).result); },
    },
  ];

  return {
    instructions: BRIDGE_INSTRUCTIONS,
    list: (): BridgeTool[] => defs.map((d) => d.tool),
    async call(name: string, args: unknown): Promise<BridgeResult> {
      const d = defs.find((x) => x.tool.name === name);
      if (!d) return { content: [{ type: "text", text: `Keystone has no tool called ${name}.` }], isError: true };
      try {
        hub.say(`Claude app → ${name.replace("keystone_", "").replace(/_/g, " ")}${(args as { jobNumber?: number })?.jobNumber ? ` #${(args as { jobNumber: number }).jobNumber}` : ""}`);
        return await d.run(args ?? {});
      } catch (e) {
        return { content: [{ type: "text", text: `Keystone couldn't do that: ${(e as Error).message}` }], isError: true };
      }
    },
  };
}
