import { query, type SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";
import type { FunctionDecl, Turn } from "../connectors/gemini/index.js";
import type { Hub } from "../hub.js";
import { ask as claudeAsk, systemPrompt } from "./run.js";
import { hubToolDefs, SERVER } from "./tools.js";

/**
 * Keystone's AI, whichever one is switched on (config.ai.provider): Claude (Anthropic API) or Gemini (Google).
 * Every AI feature goes through here, except the Estimator tab and setting up selections, which use the
 * Claude-only estimating skill.
 */
export type Provider = "claude" | "gemini" | "off";

export const aiProvider = (hub: Hub): Provider => (hub.cfg.ai?.provider === "gemini" && !hub.gemini ? "off" : hub.cfg.ai?.provider ?? (hub.cfg.anthropicApiKey ? "claude" : "off"));
export const aiReady = (hub: Hub) => aiProvider(hub) !== "off";
export const aiName = (hub: Hub) => ({ claude: "Claude", gemini: "Gemini", off: "AI" })[aiProvider(hub)];
/** The estimating skill only runs on Claude. */
export const claudeOnlyReady = (hub: Hub) => aiProvider(hub) === "claude";

export function aiOffReason(hub: Hub): string {
  if (hub.cfg.ai?.provider === "gemini" || process.env.HUB_AI === "gemini") return "Gemini is off: add GEMINI_API_KEY to Keystone's .env (aistudio.google.com/apikey) and restart.";
  return "AI is off on this machine: add GEMINI_API_KEY (Gemini) or ANTHROPIC_API_KEY (Claude) to Keystone's .env and restart.";
}

/**
 * One question, one answer: plain text, or JSON shaped by `schema` (a JSON Schema). `fast` uses the quicker,
 * cheaper model (summaries, tasks from email).
 */
export async function complete<T = string>(hub: Hub, o: { system: string; prompt: string; schema?: Record<string, unknown>; fast?: boolean }): Promise<T> {
  const p = aiProvider(hub);
  if (p === "off") throw new Error(aiOffReason(hub));
  if (p === "gemini") {
    const r = await hub.gemini!.generate({ model: o.fast ? hub.cfg.ai.geminiFastModel : hub.cfg.ai.geminiModel, fallbackModels: o.fast ? [hub.cfg.ai.geminiModel, ...(hub.cfg.ai.geminiFallbacks ?? [])] : hub.cfg.ai.geminiFallbacks, system: o.system, contents: [{ role: "user", parts: [{ text: o.prompt }] }], jsonSchema: o.schema });
    if (!o.schema) return r.text as T;
    try {
      return JSON.parse(r.text) as T;
    } catch {
      return JSON.parse(r.text.match(/\{[\s\S]*\}/)?.[0] ?? "{}") as T;
    }
  }
  let out: any = o.schema ? null : "";
  for await (const m of query({
    prompt: o.prompt,
    options: {
      model: o.fast ? hub.cfg.fastModel : hub.cfg.model,
      maxTurns: 2,
      allowedTools: [],
      settingSources: [],
      ...(o.schema ? { outputFormat: { type: "json_schema" as const, schema: o.schema } } : {}),
      canUseTool: async () => ({ behavior: "deny" as const, message: "No tools needed." }),
      systemPrompt: o.system,
      env: { ...(process.env as Record<string, string>), ...(hub.cfg.anthropicApiKey ? { ANTHROPIC_API_KEY: hub.cfg.anthropicApiKey } : {}) },
    },
  })) {
    if (m.type === "result") {
      if (m.subtype !== "success") throw new Error(`Claude stopped (${m.subtype}).`);
      out = o.schema ? ((m as any).structured_output ?? JSON.parse(m.result.match(/\{[\s\S]*\}/)?.[0] ?? "null")) : m.result;
    }
  }
  return out as T;
}

/**
 * A request that may use Keystone's tools (read jobs and email, check the calendar, make drafts...): Ask Claude
 * and the daily brief. With Gemini, its function calling runs the same tools Claude uses, and approvals work the
 * same way. `onMessage` gets Claude-style messages either way (the brief and Ask use them to show progress).
 */
export async function agentAsk(hub: Hub, prompt: string, opts: { jobNumber?: number; onMessage?: (m: SDKMessage) => void; maxSteps?: number } = {}): Promise<string> {
  const p = aiProvider(hub);
  if (p === "off") throw new Error(aiOffReason(hub));
  if (p === "claude") return claudeAsk(hub, prompt, opts);

  const defs = hubToolDefs(hub);
  const decls: FunctionDecl[] = defs.map((d: any) => ({ name: d.name, description: String(d.description).slice(0, 1000), parametersJsonSchema: toSchema(d.inputSchema) }));
  const system = `${systemPrompt(hub, opts.jobNumber)}

Right now it's ${new Date().toLocaleString("en-US", { timeZone: "America/Denver", weekday: "long", year: "numeric", month: "long", day: "numeric", hour: "numeric", minute: "2-digit" })} (Denver time). "Tomorrow", "this morning" and "next week" are relative to that.

You're running on Gemini inside Keystone. Use the functions provided for anything about jobs, email, the calendar, tasks, contacts and Homebase; read before you answer, and never guess job facts. You can't run the estimating skill or open files here: for estimating, pricing or revising an estimate, tell Hunter to use the Estimator tab. Email is drafts only.`;
  const contents: Turn[] = [{ role: "user", parts: [{ text: prompt }] }];
  for (let step = 0; step < (opts.maxSteps ?? 24); step++) {
    compactOlder(contents);
    const r = await hub.gemini!.generate({ model: hub.cfg.ai.geminiModel, fallbackModels: hub.cfg.ai.geminiFallbacks, system, contents, tools: decls });
    contents.push(r.turn);
    if (r.text && r.calls.length) hub.say(r.text);
    if (!r.calls.length) {
      opts.onMessage?.({ type: "assistant", message: { content: [{ type: "text", text: r.text }] } } as any);
      return r.text;
    }
    opts.onMessage?.({ type: "assistant", message: { content: r.calls.map((c) => ({ type: "tool_use", name: `mcp__${SERVER}__${c.name}`, input: c.args })) } } as any);
    const replies = [];
    for (const c of r.calls) {
      hub.say(`  → ${c.name} ${short(c.args)}`);
      const d: any = defs.find((x: any) => x.name === c.name);
      let result: string;
      if (!d) result = `Error: there's no function called ${c.name}.`;
      else {
        try {
          const args = z.object(d.inputSchema).parse(c.args ?? {});
          const out = await d.handler(args, {});
          result = (out?.content ?? []).map((x: any) => x.text ?? "").join("\n");
        } catch (e) {
          result = `Error: ${(e as Error).message}`;
        }
      }
      replies.push({ functionResponse: { name: c.name, ...(c.id ? { id: c.id } : {}), response: { result: slim(result) } } });
    }
    contents.push({ role: "user", parts: replies });
  }
  throw new Error("Gemini kept going without finishing; try asking in smaller steps.");
}

/**
 * Keeps what goes to Gemini small (the free tier allows 250k input tokens a minute, and every step re-sends the
 * whole conversation): tool results lose HTML copies of emails, long text is cut, JSON is sent without padding.
 */
export const RESULT_MAX = 12_000;
export function slim(result: string, max = RESULT_MAX): string {
  let out = result;
  try {
    const walk = (x: any): any => {
      if (Array.isArray(x)) return x.slice(0, 40).map(walk);
      if (x && typeof x === "object") {
        const o: Record<string, unknown> = {};
        for (const [k, v] of Object.entries(x)) if (!["html", "raw", "payload"].includes(k)) o[k] = walk(v);
        return o;
      }
      return typeof x === "string" && x.length > 2500 ? `${x.slice(0, 2500)}…(cut)` : x;
    };
    out = JSON.stringify(walk(JSON.parse(result)));
  } catch {
    // not JSON: keep as text
  }
  return out.length > max ? `${out.slice(0, max)}…(cut: ${out.length - max} more characters)` : out;
}

/** Results Gemini has already used (all but the latest round) shrink to a short stub on later steps. */
export function compactOlder(contents: Turn[], keep = 1500) {
  const rounds = contents.map((t, i) => (t.parts.some((p) => p.functionResponse) ? i : -1)).filter((i) => i >= 0);
  for (const i of rounds.slice(0, -1)) {
    for (const p of contents[i].parts) {
      const r = p.functionResponse?.response as { result?: string } | undefined;
      if (r?.result && r.result.length > keep) r.result = `${r.result.slice(0, keep)}…(already read; trimmed)`;
    }
  }
}

function toSchema(shape: Record<string, z.ZodType> | undefined): Record<string, unknown> {
  const s = z.toJSONSchema(z.object(shape ?? {}), { unrepresentable: "any" }) as Record<string, unknown>;
  delete s.$schema;
  return s;
}

function short(x: unknown) {
  const s = JSON.stringify(x);
  return s.length > 140 ? `${s.slice(0, 140)}…` : s;
}
