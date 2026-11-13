import { query, type Query, type SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { Turn } from "../connectors/gemini/index.js";
import type { Hub } from "../hub.js";
import { agentOptions, systemPrompt } from "./run.js";
import { SERVER } from "./tools.js";
import { sketchFiles } from "../workflows/dossier.js";
import { jobWalks } from "../workflows/walks.js";

/**
 * The Estimator tab: a running conversation with Claude about one job, the way Hunter works with the
 * forefront-estimate skill in chat. Each job keeps its own conversation (notes/estimator-chat.json); follow-up
 * messages resume the same Claude session, so "make the hallway LVP instead" works like it does in chat.
 * All estimating rules come from the skill; this file only carries the conversation and lists what it made.
 */
export type StudioRole = "user" | "assistant" | "tool" | "error" | "check" | "cost";
/** Who writes: Claude's main model, Claude's cheaper model, or Gemini (free). */
export type Writer = "claude" | "claude-lite" | "gemini";
/** The cheaper Claude model offered in the Estimator next to the main one. */
export const LITE_MODEL = "claude-sonnet-5-5";
export interface StudioTurn {
  role: StudioRole;
  text: string;
  at: string;
}
export type StudioEvent =
  | { kind: "turn"; job: number; turn: StudioTurn }
  | { kind: "delta"; job: number; text: string }
  | { kind: "state"; job: number; running: boolean; writer?: Writer };

interface Saved {
  sessionId?: string;
  turns: StudioTurn[];
  /** The conversation as Gemini needs it back (its own format), when Gemini is writing this job's estimate. */
  gemini?: Turn[];
  /** Which AI wrote last in this conversation. */
  writer?: Writer;
  /** What Claude has cost on this job's conversation so far, in dollars (as the API reports it). */
  cost?: number;
}

/** The documents this tab tracks, by the file names the skill writes. */
export const DOCS = [
  { key: "estimate", label: "Reconstruction Estimate", suffix: " - Reconstruction Estimate.pdf" },
  { key: "agreement", label: "Reconstruction Agreement", suffix: " - Reconstruction Agreement.pdf" },
  { key: "xactimate", label: "Xactimate Estimate", suffix: " - Xactimate Estimate.pdf" },
  { key: "selections", label: "Selections sign-off", suffix: " - Material Selection Approval.pdf" },
  { key: "photos", label: "Photo report", suffix: " - Photo Report.pdf" },
  { key: "subs", label: "Sub work order", suffix: " - Sub Work Order.pdf" },
] as const;

const STUDIO_PROMPT = `

You are in Keystone's Estimator tab. Hunter works with you here the way he does with the forefront-estimate skill in a chat: one running conversation per job, and he can see the job's documents next to the chat. Load the skill first and follow it exactly. Typical asks:
Before you scope, price or revise ANY estimate, go through everything on the job first. Call mcp__${SERVER}__job_review, then actually read what it lists: every document in files/, notes/ and email attachments (Xactimate PDFs, reports, the customer's lists), the walk-recording transcripts, the photos (follow the review's photos.howTo: when it gives contact sheets and notes, use those; otherwise run the skill's photo_sheets.py on the folder, its subfolders and the CompanyCam previews in photos/previews, and look at the sheets), and the emails and texts with the customer, adjuster and anyone else on the job (when the review gives a "conversation" digest, work from its points and open the original thread only where a point decides scope, quantity or price). What people asked for, agreed to or ruled out in an email or a text is part of the scope. Then, before pricing, tell Hunter in a few lines what you went through (how many files, photos, emails, texts), anything in them that changes the scope, anything that conflicts (say which source says what), and everything on the review's "missing" list so he knows what wasn't checked. If something important is missing (no sketch, no photos), ask before going on. Do this again for a revision if new files, photos or messages have come in.
- "New estimate": after that review, gather the DocuSketch files (sketch/, files/, photos/ subfolders; mcp__${SERVER}__docusketch_find_sketch looks for the delivery email). DocuSketch doesn't always give an .ESX: the job may only have DocuSketch's PDF (floor plan, measurements), its room images or a zip of them (unpacked under photos/). Use whatever DocuSketch files there are, reading measurements from them and from the walk transcript; never stop or ask just because there's no .ESX. Then scope, price, write the customer wording, then render all three documents into the job's estimate/ folder.
- "Convert" an Xactimate PDF (in files/ or estimate/) into the Reconstruction Estimate / Agreement per the skill.
- "Agreement" with selections or allowances: fill selections in estimate.json per the skill and re-render.
- "Selections sign-off": render the Material Selection Approval sheet with render.py --only selections.
- "Photo report": pick the photos and captions and use mcp__${SERVER}__photo_report.
- Revisions: edit estimate.json and re-render (Keystone snapshots the old version first).
Claude costs Hunter money for every step and everything you read, so work economically without cutting corners on accuracy:
- Call mcp__${SERVER}__job_review once per conversation; don't re-read a file, thread or photo sheet you've already read unless it changed.
- Look at photos as contact sheets (photo_sheets.py), not one full-size photo at a time; open a full-size photo only when a sheet shows something you must see closer.
- Look prices up in batches: several items in one price_lookup.py run where you can, and never look the same item up twice.
- Don't narrate between steps or repeat the estimate back in full; say what changed and the totals.
- Don't re-render until the estimate.json is complete; one render per change.
- After you render, Keystone checks the estimate for free (prices against the price book, quantities against the rooms, and the scope against Hunter's notes) and shows him the result. Don't spend steps re-checking arithmetic yourself; get the scope, quantities and wording right the first time.
When the skill has questions for Hunter, ask them here in a short numbered list and wait for his answers; don't guess. Files he drops into this chat are saved in the job folder and named in his message. After rendering, say which files you wrote and the totals in two or three lines. Don't draft or send email from this tab unless he asks.`;

export class Studio {
  private live = new Map<number, { interrupt(): Promise<unknown> }>();

  constructor(private hub: Hub, private emit: (e: StudioEvent) => void) {}

  private file(job: number) {
    return this.hub.jobs.path(job, "notes", "estimator-chat.json");
  }

  load(job: number): Saved {
    const f = this.file(job);
    if (!existsSync(f)) return { turns: [] };
    try {
      return JSON.parse(readFileSync(f, "utf8"));
    } catch {
      return { turns: [] };
    }
  }

  private save(job: number, s: Saved) {
    mkdirSync(path.dirname(this.file(job)), { recursive: true });
    writeFileSync(this.file(job), JSON.stringify(s, null, 2));
  }

  running(job: number) {
    return this.live.has(job);
  }

  /** The conversation, whether Claude is working on it, and the job's documents and inputs. */
  view(job: number) {
    const s = this.load(job);
    return { turns: s.turns, running: this.running(job), hasSession: !!s.sessionId || !!s.gemini?.length, writer: s.writer ?? null, cost: s.cost ?? 0, liteModel: LITE_MODEL, mainModel: this.hub.cfg.model, ...this.files(job) };
  }

  files(job: number) {
    const rel = (f: string) => path.relative(this.hub.jobs.folder(job), f).split(path.sep).join("/");
    const info = (f: string) => ({ path: rel(f), name: path.basename(f), modified: statSync(f).mtime.toISOString() });
    const est = this.hub.jobs.files(job, "estimate", /\.pdf$/i);
    const docs = DOCS.map((d) => {
      const f = est.find((x) => path.basename(x).endsWith(d.suffix));
      return { key: d.key, label: d.label, file: f ? info(f) : null };
    });
    const known = new Set(docs.flatMap((d) => (d.file ? [d.file.path] : [])));
    const json = this.hub.jobs.files(job, "estimate", /^estimate\.json$/i)[0];
    const revDir = this.hub.jobs.path(job, "estimate", "revisions");
    return {
      docs,
      otherPdfs: [...est, ...this.hub.jobs.files(job, "files", /\.pdf$/i)].map(info).filter((x) => !known.has(x.path)).slice(0, 12),
      estimateJson: json ? info(json) : null,
      revisions: existsSync(revDir) ? readdirSync(revDir).filter((d) => /^v\d+$/.test(d)).length : 0,
      inputs: {
        sketches: this.hub.jobs.files(job, "sketch", /\.esx$/i).map(info),
        // DocuSketch material that isn't an ESX: its PDFs and images, wherever they were filed.
        sketchOther: sketchFiles(this.hub, job).filter((f) => !/\.esx$/i.test(f)).length,
        photos: this.hub.jobs.files(job, "photos", /\.(jpe?g|png|heic|webp)$/i).length,
        walks: jobWalks(this.hub, job).length,
      },
    };
  }

  /** Starts a fresh conversation for the job (the old one stays in the file's history under "previous"). */
  reset(job: number) {
    if (this.running(job)) throw new Error("Claude is still working on this job. Stop it first.");
    const s = this.load(job);
    if (s.turns.length) {
      const old = this.hub.jobs.path(job, "notes", `estimator-chat ${new Date().toISOString().slice(0, 16).replace(/[:T]/g, "-")}.json`);
      writeFileSync(old, JSON.stringify(s, null, 2));
    }
    this.save(job, { turns: [] });
  }

  /** Which AI last wrote in this job's conversation (so the tab can keep using it). */
  writer(job: number): Writer {
    return this.load(job).writer ?? "claude";
  }

  async stop(job: number) {
    await this.live.get(job)?.interrupt().catch(() => {});
  }

  /** Sends one message from Hunter; resolves when Claude's turn is over. */
  async send(job: number, text: string, ai: Writer = "claude"): Promise<void> {
    const before = this.estimateStamp(job);
    try {
      await (ai === "gemini" ? this.sendGemini(job, text) : this.sendClaude(job, text, ai));
    } finally {
      // A new or changed estimate gets Keystone's free check, shown in the conversation.
      if (this.estimateStamp(job) !== before) await this.check(job).catch(() => {});
    }
  }

  private estimateStamp(job: number): number {
    const f = this.hub.jobs.path(job, "estimate", "estimate.json");
    return existsSync(f) ? statSync(f).mtimeMs : 0;
  }

  /** Keystone's free check of the job's estimate, added to the conversation. Returns the text, or null without an estimate. */
  async check(job: number): Promise<string | null> {
    const { checkEstimate, checkText } = await import("../workflows/estimateCheck.js");
    const c = await checkEstimate(this.hub, job);
    if (!c) return null;
    const s = this.load(job);
    const turn = { role: "check" as const, text: checkText(c), at: new Date().toISOString() };
    s.turns.push(turn);
    this.save(job, s);
    this.emit({ kind: "turn", job, turn });
    return turn.text;
  }

  private async sendClaude(job: number, text: string, ai: Writer): Promise<void> {
    if (!this.hub.cfg.anthropicApiKey) throw new Error("Claude is off on this machine (no Anthropic API key). Set ANTHROPIC_API_KEY in .env, or save it in the Estimator app.");
    if (this.running(job)) throw new Error("Claude is still working on this job. Wait, or press Stop.");
    const s = this.load(job);
    const add = (role: StudioRole, t: string) => {
      const turn = { role, text: t, at: new Date().toISOString() };
      s.turns.push(turn);
      this.save(job, s);
      this.emit({ kind: "turn", job, turn });
    };
    s.writer = ai;
    add("user", text);
    const model = ai === "claude-lite" ? LITE_MODEL : this.hub.cfg.model;

    const q = query({
      prompt: text,
      options: agentOptions(
        this.hub,
        {
          ...(s.sessionId ? { resume: s.sessionId } : {}),
          includePartialMessages: true,
          model,
          maxTurns: 120, // a ceiling so a stuck run can't keep spending
          systemPrompt: { type: "preset", preset: "claude_code", append: systemPrompt(this.hub, job) + STUDIO_PROMPT },
        },
        job,
      ),
    });
    this.live.set(job, q);
    this.emit({ kind: "state", job, running: true, writer: ai });
    try {
      const { withDraftSource } = await import("../workflows/generated.js");
      await withDraftSource("Estimator", async () => {
        for await (const m of q) this.handle(job, s, m, add);
      });
    } catch (e) {
      add("error", (e as Error).message);
    } finally {
      this.live.delete(job);
      this.save(job, s);
      this.emit({ kind: "state", job, running: false });
    }
  }

  /** The same conversation, written by Gemini (free) with the skill's instructions and scripts. A trial next to Claude. */
  private async sendGemini(job: number, text: string): Promise<void> {
    if (this.running(job)) throw new Error("The estimator is still working on this job. Wait, or press Stop.");
    const s = this.load(job);
    const add = (role: StudioRole, t: string) => {
      const turn = { role, text: t, at: new Date().toISOString() };
      s.turns.push(turn);
      this.save(job, s);
      this.emit({ kind: "turn", job, turn });
    };
    s.writer = "gemini";
    add("user", text);
    let stop = false;
    this.live.set(job, { interrupt: async () => void (stop = true) });
    this.emit({ kind: "state", job, running: true, writer: "gemini" });
    try {
      const { forSaving, geminiEstimate } = await import("./geminiEstimator.js");
      const { withDraftSource } = await import("../workflows/generated.js");
      await withDraftSource("Estimator", async () => {
        const r = await geminiEstimate(this.hub, job, text, { history: s.gemini, stopped: () => stop, onStep: (line) => add("tool", line), onText: (t) => add("assistant", t) });
        s.gemini = forSaving(r.contents).slice(-400);
        add(r.stopped ? "error" : "assistant", r.stopped ? "Stopped." : `${r.text}\n\n(Written by Gemini: ${r.models.join(", ") || this.hub.cfg.ai.geminiModel}${r.models.some((m) => m !== this.hub.cfg.ai.geminiModel) ? `. The main model, ${this.hub.cfg.ai.geminiModel}, was busy or at its free limit for part of this, so a lighter one filled in` : ""}. This is a trial: check quantities and prices before you send anything.)`);
      });
    } catch (e) {
      add("error", (e as Error).message);
    } finally {
      this.live.delete(job);
      this.save(job, s);
      this.emit({ kind: "state", job, running: false });
    }
  }

  private handle(job: number, s: Saved, m: SDKMessage, add: (role: StudioRole, t: string) => void) {
    if (m.type === "system" && m.subtype === "init" && m.session_id) {
      s.sessionId = m.session_id;
      this.save(job, s);
    } else if (m.type === "stream_event") {
      const ev = m.event as { type: string; delta?: { type: string; text?: string } };
      if (ev.type === "content_block_delta" && ev.delta?.type === "text_delta" && ev.delta.text) this.emit({ kind: "delta", job, text: ev.delta.text });
    } else if (m.type === "assistant") {
      for (const b of m.message.content) {
        if (b.type === "text" && b.text.trim()) add("assistant", b.text.trim());
        if (b.type === "tool_use") add("tool", describeTool(b.name, b.input as Record<string, unknown>));
      }
    } else if (m.type === "result") {
      // What this message cost, as the API reports it, and the job's running total.
      const spent = Number((m as { total_cost_usd?: number }).total_cost_usd);
      if (Number.isFinite(spent) && spent > 0) {
        s.cost = Math.round(((s.cost ?? 0) + spent) * 10000) / 10000;
        add("cost", `That used about $${spent.toFixed(2)} of Claude. This job's conversation so far: $${s.cost.toFixed(2)}.`);
      }
      if (m.subtype !== "success") add("error", m.subtype === "error_max_turns" ? "Claude hit its step limit. Say \"keep going\" to continue." : `Claude stopped (${m.subtype}).`);
    }
  }
}

/** One plain line per tool step, for the chat ("Running render.py", "Reading Wegener.ESX"). */
export function describeTool(name: string, input: Record<string, unknown>): string {
  const short = name.replace(`mcp__${SERVER}__`, "");
  const base = (p: unknown) => path.basename(String(p ?? "")) || "file";
  switch (short) {
    case "Skill":
      return `Loading the ${String(input.skill ?? input.command ?? "estimating")} skill`;
    case "Read":
      return `Reading ${base(input.file_path)}`;
    case "Write":
      return `Writing ${base(input.file_path)}`;
    case "Edit":
    case "MultiEdit":
      return `Editing ${base(input.file_path)}`;
    case "Glob":
    case "Grep":
      return `Looking through the job folder`;
    case "Bash":
    case "PowerShell": {
      const cmd = String(input.command ?? "");
      const script = cmd.match(/([\w-]+\.py)\b/)?.[1];
      return script ? `Running ${script}${/--only\s+selections/.test(cmd) ? " (selections sheet)" : ""}` : String(input.description ?? "Running a command");
    }
    case "TodoWrite":
      return "Planning the steps";
    default: {
      const job = input.jobNumber ? ` #${input.jobNumber}` : "";
      const plain: Record<string, string> = {
        job_timeline: `Reading the history on${job || " a job"}`,
        job_read: `Opening${job || " a job"}`,
        gmail_search: "Searching Gmail",
        gmail_read_thread: "Reading an email",
        job_review: `Going through everything on${job || " the job"}: files, photos, CompanyCam, emails, texts`,
        gmail_create_draft: `Drafting an email${job ? ` for${job}` : ""}`,
        calendar_events: "Checking your calendar",
        calendar_free: "Finding free time",
        tasks_list: "Checking your tasks",
        hub_today: "Looking at what needs you",
        homebase_get_job: `Reading${job || " a job"} in Homebase`,
        ToolSearch: "Getting Keystone's tools ready",
      };
      return plain[short] ?? short.replace(/_/g, " ");
    }
  }
}
