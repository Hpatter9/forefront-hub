import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { z } from "zod";
import type { FunctionDecl, Part, Turn } from "../connectors/gemini/index.js";
import type { Hub } from "../hub.js";
import { BUSY_RX, BUSY_WAITS, slim } from "./llm.js";
import { systemPrompt } from "./run.js";
import { hubToolDefs } from "./tools.js";

/**
 * The Estimator on Gemini (free), as a trial next to Claude. Gemini has no file system, shell or skills of its own,
 * so Keystone gives it the estimating skill's instructions (SKILL.md, word for word) and four narrow tools that do
 * what the skill asks for: list and read files, look at photos and PDFs, write files in the job folder, and run the
 * skill's own scripts (read_esx, price_lookup, render, ...). Nothing about scoping or pricing lives here: the rules
 * are the skill's, the numbers come from its price book through its scripts.
 * The same guard as Claude's applies: writes stay inside the job folder, the skill is never edited, and replacing
 * an existing estimate asks Hunter first and keeps the old version in estimate/revisions.
 */
export const SCRIPTS = ["read_esx.py", "read_xactimate.py", "price_lookup.py", "render.py", "photo_sheets.py", "photo_report.py"];
/** Keystone tools the estimator may also use (everything about the job; nothing that sends or schedules). */
const HUB_TOOLS = ["job_review", "job_get", "job_update", "homebase_get_job", "job_timeline", "gmail_read_thread", "docusketch_find_sketch", "companycam_download_photos", "estimate_status", "photo_report", "shop_stock", "contacts_find"];
const MEDIA: Record<string, string> = { ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".png": "image/png", ".webp": "image/webp", ".gif": "image/gif", ".pdf": "application/pdf" };
const TEXT_MAX = 40_000;

const inside = (file: string, dir: string) => {
  const rel = path.relative(path.resolve(dir), path.resolve(file));
  return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
};

export interface EstimatorTools {
  decls: FunctionDecl[];
  /** Runs one tool. `media` are files to show Gemini alongside the answer (photos, PDFs). */
  run(name: string, args: Record<string, unknown>): Promise<{ result: string; media?: { mimeType: string; data: string }[] }>;
  describe(name: string, args: Record<string, unknown>): string;
}

export function estimatorTools(hub: Hub, job: number): EstimatorTools {
  const jobDir = hub.jobs.folder(job), skillDir = hub.cfg.skillDir;
  /** "skill/references/x.md" is the skill; anything else is inside the job folder. Nothing else is reachable. */
  const resolve = (p: unknown, write = false): string => {
    const raw = String(p ?? "").trim().replace(/\\/g, "/");
    if (!raw) throw new Error("Give a path.");
    const full = raw.startsWith("skill/") || raw === "skill" ? path.join(skillDir, raw.slice(5)) : path.isAbsolute(raw) ? raw : path.join(jobDir, raw);
    if (write ? !inside(full, jobDir) : !inside(full, jobDir) && !inside(full, skillDir)) throw new Error(write ? "Files can only be written inside this job's folder." : "Only this job's folder and the skill (skill/...) can be read.");
    return full;
  };
  const rel = (f: string) => (inside(f, skillDir) ? `skill/${path.relative(skillDir, f)}` : path.relative(jobDir, f)).split(path.sep).join("/");
  const hasEstimate = () => existsSync(path.join(jobDir, "estimate")) && readdirSync(path.join(jobDir, "estimate")).some((f) => / - (Reconstruction Estimate|Reconstruction Agreement|Xactimate Estimate)\.pdf$/.test(f));
  /** Replacing the estimate: Hunter says yes first, and the old files are kept. */
  const overwrite = async (what: string) => {
    if (!(await hub.approver.confirm(`${what}? This overwrites the current estimate; the old files go to estimate/revisions/.`))) throw new Error("Hunter said not to overwrite the estimate. Ask what he wants instead.");
    const snap = hub.jobs.snapshotEstimate(job);
    if (snap) hub.say(`Saved the previous estimate to ${snap}`);
  };

  const hubDefs = (hubToolDefs(hub) as any[]).filter((d) => HUB_TOOLS.includes(d.name));
  const own: Record<string, { description: string; schema: Record<string, z.ZodType>; run: (a: any) => Promise<{ result: string; media?: { mimeType: string; data: string }[] }> }> = {
    list_files: {
      description: "List the files in a folder of this job (\"\" for the job folder itself: sketch, photos, estimate, files, notes, email) or of the skill (\"skill\", \"skill/references\", \"skill/scripts\").",
      schema: { dir: z.string().default("") },
      run: async ({ dir }) => {
        const d = dir ? resolve(dir) : jobDir;
        if (!existsSync(d)) return { result: "That folder doesn't exist." };
        return { result: JSON.stringify(readdirSync(d).filter((f) => f !== "__pycache__").slice(0, 300).map((f) => { const s = statSync(path.join(d, f)); return s.isDirectory() ? `${f}/` : `${f} (${Math.max(1, Math.round(s.size / 1024))} KB)`; })) };
      },
    },
    read_file: {
      description: `Read a text file (md, txt, json, csv) from this job's folder or the skill ("skill/references/scoping_guide.md"). Up to ${TEXT_MAX} characters per call; pass offset to continue. For the price book CSVs use run_script price_lookup.py instead of reading them. For photos and PDFs use view_files.`,
      schema: { path: z.string(), offset: z.number().int().min(0).default(0) },
      run: async ({ path: p, offset }) => {
        const f = resolve(p);
        if (!existsSync(f)) return { result: "No such file. Use list_files to see what's there." };
        if (MEDIA[path.extname(f).toLowerCase()] || /\.(esx|zip|xlsx|m4a|mp3)$/i.test(f)) return { result: /\.esx$/i.test(f) ? "An .ESX is read with run_script read_esx.py." : "That isn't a text file. Use view_files for photos and PDFs." };
        const text = readFileSync(f, "utf8");
        const part = text.slice(offset, offset + TEXT_MAX);
        return { result: part + (offset + TEXT_MAX < text.length ? `\n…(${text.length - offset - TEXT_MAX} more characters: call again with offset ${offset + TEXT_MAX})` : "") };
      },
    },
    view_files: {
      description: "Look at photos or PDFs (jpg, png, webp, pdf) from this job's folder: contact sheets from photo_sheets.py, single photos, an Xactimate or report PDF. Up to 6 files per call. Look at contact sheets rather than every full-size photo.",
      schema: { paths: z.array(z.string()).min(1).max(6) },
      run: async ({ paths }) => {
        const media: { mimeType: string; data: string }[] = [], notes: string[] = [];
        for (const p of paths as string[]) {
          const f = resolve(p), type = MEDIA[path.extname(f).toLowerCase()];
          if (!existsSync(f)) notes.push(`${p}: no such file`);
          else if (!type) notes.push(`${p}: not a photo or PDF (use read_file)`);
          else if (statSync(f).size > (type === "application/pdf" ? 12 : 5) * 1024 * 1024) notes.push(`${p}: too big to show (${Math.round(statSync(f).size / 1024 / 1024)} MB). For photos, make contact sheets with photo_sheets.py or use photos/previews.`);
          else { media.push({ mimeType: type, data: readFileSync(f).toString("base64") }); notes.push(`${p}: shown below`); }
        }
        return { result: notes.join("\n"), media };
      },
    },
    write_file: {
      description: "Write a text file inside this job's folder (estimate/estimate.json, notes/..., a picks JSON for the photo report). Replaces the file if it exists; replacing estimate.json asks Hunter first and keeps the old version.",
      schema: { path: z.string(), content: z.string() },
      run: async ({ path: p, content }) => {
        const f = resolve(p, true);
        if (path.basename(f) === "estimate.json" && existsSync(f)) await overwrite("Change estimate.json");
        mkdirSync(path.dirname(f), { recursive: true });
        writeFileSync(f, content);
        return { result: `Wrote ${rel(f)} (${content.length} characters).` };
      },
    },
    run_script: {
      description: `Run one of the estimating skill's scripts with Python, from this job's folder: ${SCRIPTS.join(", ")}. Give the arguments exactly as the skill's instructions show them, as a list; file paths are relative to the job folder ("sketch/Job.ESX", "estimate/estimate.json", "--out", "estimate"). Returns what the script printed.`,
      schema: { script: z.string(), args: z.array(z.string()).default([]) },
      run: async ({ script, args }) => {
        const name = path.basename(String(script));
        if (!SCRIPTS.includes(name)) return { result: `Only these scripts can be run: ${SCRIPTS.join(", ")}.` };
        const list = (args as string[]).map(String);
        // Paths in the arguments must stay inside the job folder or the skill.
        for (const a of list) if ((path.isAbsolute(a) || a.includes("..")) && !inside(path.resolve(jobDir, a), jobDir) && !inside(path.resolve(jobDir, a), skillDir)) return { result: `That path is outside the job folder: ${a}` };
        if (name === "render.py" && hasEstimate() && !(list.includes("--only") && list[list.indexOf("--only") + 1] === "selections")) await overwrite("Re-render the estimate PDFs");
        return { result: await runPython(hub, path.join(skillDir, "scripts", name), list, jobDir) };
      },
    },
  };

  const toSchema = (shape: Record<string, z.ZodType>) => {
    const s = z.toJSONSchema(z.object(shape), { unrepresentable: "any" }) as Record<string, unknown>;
    delete s.$schema;
    return s;
  };
  return {
    decls: [...Object.entries(own).map(([name, t]) => ({ name, description: t.description, parametersJsonSchema: toSchema(t.schema) })), ...hubDefs.map((d) => ({ name: d.name, description: String(d.description).slice(0, 1000), parametersJsonSchema: toSchema(d.inputSchema) }))],
    async run(name, args) {
      try {
        if (own[name]) return await own[name].run(z.object(own[name].schema).parse(args ?? {}));
        const d = hubDefs.find((x) => x.name === name);
        if (!d) return { result: `Error: there's no function called ${name}.` };
        const out = await d.handler(z.object(d.inputSchema).parse(args ?? {}), {});
        return { result: slim((out?.content ?? []).map((x: any) => x.text ?? "").join("\n"), name === "job_review" ? 60_000 : 12_000) };
      } catch (e) {
        return { result: `Error: ${(e as Error).message}` };
      }
    },
    describe(name, a) {
      const base = (p: unknown) => path.basename(String(p ?? "")) || "the folder";
      if (name === "read_file") return `Reading ${base(a.path)}`;
      if (name === "view_files") return `Looking at ${(a.paths as string[] | undefined)?.length === 1 ? base((a.paths as string[])[0]) : `${(a.paths as string[] | undefined)?.length ?? 0} photos or PDFs`}`;
      if (name === "write_file") return `Writing ${base(a.path)}`;
      if (name === "run_script") return `Running ${base(a.script)}`;
      if (name === "list_files") return "Looking through the folders";
      if (name === "job_review") return "Going through everything on the job: files, photos, CompanyCam, emails, texts";
      return name.replace(/_/g, " ");
    },
  };
}

export function runPython(hub: Hub, script: string, args: string[], cwd: string): Promise<string> {
  return new Promise((resolve) => {
    const [cmd, ...pre] = hub.cfg.python.split(" ");
    const child = spawn(cmd, [...pre, script, ...args], { cwd, env: { ...process.env, PYTHONIOENCODING: "utf-8" } });
    let out = "";
    const take = (b: Buffer) => { if (out.length < 400_000) out += b.toString("utf8"); };
    child.stdout.on("data", take);
    child.stderr.on("data", take);
    const timer = setTimeout(() => { child.kill(); out += "\n(Stopped: the script ran longer than 5 minutes.)"; }, 5 * 60_000);
    child.on("error", (e) => { clearTimeout(timer); resolve(`Couldn't start Python: ${e.message}`); });
    child.on("close", (code) => {
      clearTimeout(timer);
      const text = out.trim() || "(no output)";
      resolve(`${code === 0 ? "" : `Exit code ${code}.\n`}${text.length > 30_000 ? `${text.slice(0, 30_000)}\n…(cut: ${text.length - 30_000} more characters)` : text}`);
    });
  });
}

/** What Gemini is told: Keystone's own notes, how its tools stand in for Claude's, then the skill itself. */
export function estimatorSystem(hub: Hub, job: number): string {
  const skill = existsSync(path.join(hub.cfg.skillDir, "SKILL.md")) ? readFileSync(path.join(hub.cfg.skillDir, "SKILL.md"), "utf8") : "";
  if (!skill) throw new Error(`The estimating skill wasn't found at ${hub.cfg.skillDir}.`);
  const refs = existsSync(path.join(hub.cfg.skillDir, "references")) ? readdirSync(path.join(hub.cfg.skillDir, "references")).filter((f) => /\.md$/.test(f)) : [];
  return `${systemPrompt(hub, job)}

You are in Keystone's Estimator tab, writing and revising estimates for job #${job} with Forefront's estimating skill. Hunter sees this conversation next to the job's documents. You are running on Gemini as a trial; Hunter will compare your work with Claude's, so follow the skill exactly and never invent a quantity, a price or a line item code.

How to work here:
- The skill below was written for an assistant with a shell. You have these instead: run_script runs the skill's scripts (wherever it says to run "python scripts/x.py ...", call run_script with script "x.py" and the same arguments as a list); read_file and list_files read the job folder and the skill ("skill/references/...", "skill/assets/..."); view_files shows you photos and PDFs; write_file writes into the job folder.
- Before each step, read the reference file the skill names for it with read_file (${refs.map((f) => `skill/references/${f}`).join(", ")}). Prices come only from price_lookup.py; never from memory.
- Before you scope, price or revise, go through everything on the job: call job_review, then read the documents and walk notes it lists and look at the photos (follow the review's photos.howTo: when it lists contact sheets and notes, view those sheets; otherwise make contact sheets with photo_sheets.py from photos/ and photos/previews and view them). When the review has a "conversation" digest, work from its points and read an original thread only where a point decides scope or quantity. Tell Hunter in a few lines what you went through, what changes the scope, what conflicts, and what was missing.
- DocuSketch doesn't always give an .ESX: the job may only have DocuSketch's PDF (floor plan, measurements), its room images or a zip of them (unpacked under photos/). Use whatever DocuSketch files there are, reading measurements from them and from the walk transcript; never stop or ask just because there's no .ESX.
- When the skill has questions for Hunter, ask them in a short numbered list and stop; don't guess. When you've rendered documents, say which files you wrote and the totals in two or three lines.
- Email: don't draft or send anything from here unless he asks.
- If a script fails, read its message, fix the input and run it again; if you can't, tell Hunter exactly what it said.

Right now it's ${new Date().toLocaleString("en-US", { timeZone: "America/Denver", weekday: "long", year: "numeric", month: "long", day: "numeric", hour: "numeric", minute: "2-digit" })} (Denver time).

===== The forefront-estimate skill (SKILL.md) =====
${skill}`;
}

/** Older rounds get lighter: photos already looked at are dropped, long results are cut. The skill's files stay whole. */
export function lighten(contents: Turn[], keepRounds = 2) {
  const rounds = contents.map((t, i) => (t.role === "user" && t.parts.some((p) => p.functionResponse) ? i : -1)).filter((i) => i >= 0);
  for (const i of rounds.slice(0, Math.max(0, rounds.length - keepRounds))) {
    const t = contents[i];
    if (t.parts.some((p) => p.inlineData)) t.parts = [...t.parts.filter((p) => !p.inlineData), { text: "(The photos or PDFs shown here were removed to save room; view them again if you need them.)" }];
    for (const p of t.parts) {
      const r = p.functionResponse?.response as { result?: string; keep?: boolean } | undefined;
      if (r?.result && !r.keep && r.result.length > 6000) r.result = `${r.result.slice(0, 6000)}…(already read; trimmed)`;
    }
  }
}

export interface GeminiRun {
  text: string;
  contents: Turn[];
  model?: string;
  /** Every Gemini model that wrote part of it (the main one, and lighter stand-ins when it was busy or at its limit). */
  models: string[];
  stopped?: boolean;
}

/** One message from Hunter, worked through to Gemini's answer (or its questions). */
export async function geminiEstimate(hub: Hub, job: number, text: string, o: { history?: Turn[]; onStep?: (line: string) => void; onText?: (text: string) => void; stopped?: () => boolean; maxSteps?: number } = {}): Promise<GeminiRun> {
  if (!hub.gemini || !hub.cfg.ai.geminiKey) throw new Error("Gemini isn't connected. Double-click Connect Gemini in the Keystone folder.");
  const tools = estimatorTools(hub, job);
  const system = estimatorSystem(hub, job);
  const contents: Turn[] = [...(o.history ?? []), { role: "user", parts: [{ text }] }];
  let model: string | undefined;
  const models: string[] = [];
  for (let step = 0; step < (o.maxSteps ?? 90); step++) {
    if (o.stopped?.()) return { text: "Stopped.", contents, model, models, stopped: true };
    lighten(contents);
    let r: Awaited<ReturnType<NonNullable<Hub["gemini"]>["generate"]>> | undefined;
    for (let attempt = 0; !r; attempt++) {
      try {
        r = await hub.gemini.generate({ model: hub.cfg.ai.geminiModel, fallbackModels: hub.cfg.ai.geminiFallbacks, system, contents, tools: tools.decls });
      } catch (e) {
        if (attempt >= BUSY_WAITS.length || !BUSY_RX.test((e as Error).message)) throw e;
        o.onStep?.(`Gemini is busy or at its free limit; trying again in ${Math.round(BUSY_WAITS[attempt] / 1000)} seconds`);
        await new Promise((res) => setTimeout(res, BUSY_WAITS[attempt]));
      }
    }
    model = r.model ?? hub.cfg.ai.geminiModel;
    if (!models.includes(model)) models.push(model);
    contents.push(r.turn);
    if (!r.calls.length) return { text: r.text || "(Gemini didn't say anything.)", contents, model, models };
    if (r.text.trim()) o.onText?.(r.text.trim());
    const parts: Part[] = [], media: Part[] = [];
    for (const c of r.calls) {
      o.onStep?.(tools.describe(c.name, c.args ?? {}));
      const out = await tools.run(c.name, c.args ?? {});
      // The skill's own files are kept whole in the conversation; everything else can be trimmed later.
      const keep = c.name === "read_file" && String(c.args?.path ?? "").replace(/\\/g, "/").startsWith("skill/");
      parts.push({ functionResponse: { name: c.name, ...(c.id ? { id: c.id } : {}), response: { result: out.result, ...(keep ? { keep: true } : {}) } } });
      for (const m of out.media ?? []) media.push({ inlineData: m });
    }
    contents.push({ role: "user", parts: [...parts, ...media] });
  }
  return { text: "I hit my step limit for one message. Say \"keep going\" and I'll continue from here.", contents, model, models };
}

/** The conversation as it's saved between messages: photos and PDFs are left out (they'd make the file huge). */
export function forSaving(contents: Turn[]): Turn[] {
  return contents.map((t) => (t.parts.some((p) => p.inlineData) ? { ...t, parts: [...t.parts.filter((p) => !p.inlineData), { text: "(Photos or PDFs were shown here.)" }] } : t));
}
