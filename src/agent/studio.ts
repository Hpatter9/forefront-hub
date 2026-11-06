import { query, type Query, type SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { Hub } from "../hub.js";
import { agentOptions, systemPrompt } from "./run.js";
import { SERVER } from "./tools.js";

/**
 * The Estimator tab: a running conversation with Claude about one job, the way Hunter works with the
 * forefront-estimate skill in chat. Each job keeps its own conversation (notes/estimator-chat.json); follow-up
 * messages resume the same Claude session, so "make the hallway LVP instead" works like it does in chat.
 * All estimating rules come from the skill; this file only carries the conversation and lists what it made.
 */
export type StudioRole = "user" | "assistant" | "tool" | "error";
export interface StudioTurn {
  role: StudioRole;
  text: string;
  at: string;
}
export type StudioEvent =
  | { kind: "turn"; job: number; turn: StudioTurn }
  | { kind: "delta"; job: number; text: string }
  | { kind: "state"; job: number; running: boolean };

interface Saved {
  sessionId?: string;
  turns: StudioTurn[];
}

/** The documents this tab tracks, by the file names the skill writes. */
export const DOCS = [
  { key: "estimate", label: "Reconstruction Estimate", suffix: " - Reconstruction Estimate.pdf" },
  { key: "agreement", label: "Reconstruction Agreement", suffix: " - Reconstruction Agreement.pdf" },
  { key: "xactimate", label: "Xactimate Estimate", suffix: " - Xactimate Estimate.pdf" },
  { key: "selections", label: "Selections sign-off", suffix: " - Material Selection Approval.pdf" },
  { key: "photos", label: "Photo report", suffix: " - Photo Report.pdf" },
] as const;

const STUDIO_PROMPT = `

You are in the hub's Estimator tab. Hunter works with you here the way he does with the forefront-estimate skill in a chat: one running conversation per job, and he can see the job's documents next to the chat. Load the skill first and follow it exactly. Typical asks:
- "New estimate": find the ESX in sketch/ (or mcp__${SERVER}__docusketch_find_sketch), look at the CompanyCam photos (mcp__${SERVER}__companycam_*), scope, price, write the customer wording, then render all three documents into the job's estimate/ folder.
- "Convert" an Xactimate PDF (in files/ or estimate/) into the Reconstruction Estimate / Agreement per the skill.
- "Agreement" with selections or allowances: fill selections in estimate.json per the skill and re-render.
- "Selections sign-off": render the Material Selection Approval sheet with render.py --only selections.
- "Photo report": pick the photos and captions and use mcp__${SERVER}__photo_report.
- Revisions: edit estimate.json and re-render (the hub snapshots the old version first).
When the skill has questions for Hunter, ask them here in a short numbered list and wait for his answers; don't guess. Files he drops into this chat are saved in the job folder and named in his message. After rendering, say which files you wrote and the totals in two or three lines. Don't draft or send email from this tab unless he asks.`;

export class Studio {
  private live = new Map<number, Query>();

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
    return { turns: s.turns, running: this.running(job), hasSession: !!s.sessionId, ...this.files(job) };
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
        photos: this.hub.jobs.files(job, "photos", /\.(jpe?g|png|heic|webp)$/i).length,
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

  async stop(job: number) {
    await this.live.get(job)?.interrupt().catch(() => {});
  }

  /** Sends one message from Hunter; resolves when Claude's turn is over. */
  async send(job: number, text: string): Promise<void> {
    if (!this.hub.cfg.anthropicApiKey) throw new Error("Claude is off on this machine (no Anthropic API key). Set ANTHROPIC_API_KEY in .env, or save it in the Estimator app.");
    if (this.running(job)) throw new Error("Claude is still working on this job. Wait, or press Stop.");
    const s = this.load(job);
    const add = (role: StudioRole, t: string) => {
      const turn = { role, text: t, at: new Date().toISOString() };
      s.turns.push(turn);
      this.save(job, s);
      this.emit({ kind: "turn", job, turn });
    };
    add("user", text);

    const q = query({
      prompt: text,
      options: agentOptions(
        this.hub,
        {
          ...(s.sessionId ? { resume: s.sessionId } : {}),
          includePartialMessages: true,
          systemPrompt: { type: "preset", preset: "claude_code", append: systemPrompt(this.hub, job) + STUDIO_PROMPT },
        },
        job,
      ),
    });
    this.live.set(job, q);
    this.emit({ kind: "state", job, running: true });
    try {
      for await (const m of q) this.handle(job, s, m, add);
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
    } else if (m.type === "result" && m.subtype !== "success") {
      add("error", m.subtype === "error_max_turns" ? "Claude hit its step limit. Say \"keep going\" to continue." : `Claude stopped (${m.subtype}).`);
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
    default:
      return short.replace(/_/g, " ");
  }
}
