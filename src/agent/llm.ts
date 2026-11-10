import { query, type SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import { claudeEnv } from "./env.js";
import { z } from "zod";
import type { FunctionDecl, Turn } from "../connectors/gemini/index.js";
import type { Hub } from "../hub.js";
import { ask as claudeAsk, systemPrompt } from "./run.js";
import { hubToolDefs, SERVER } from "./tools.js";

/**
 * Keystone's AI, whichever one is switched on (config.ai.provider): Claude (Anthropic API) or Gemini (Google).
 * Every everyday AI feature goes through here (Gemini, free). The paid Claude API is only for the estimating
 * skill: the Estimator tab, setting up selections and the send-off's report photo picks.
 */
export type Provider = "claude" | "gemini" | "off";

export const aiProvider = (hub: Hub): Provider => (hub.cfg.ai?.provider === "gemini" && !hub.gemini ? "off" : hub.cfg.ai?.provider ?? (hub.cfg.anthropicApiKey ? "claude" : "off"));
export const aiReady = (hub: Hub) => aiProvider(hub) !== "off";
export const aiName = (hub: Hub) => ({ claude: "Claude", gemini: "Gemini", off: "AI" })[aiProvider(hub)];

/** Which AI and model did a piece of work, e.g. "Gemini (gemini-3.5-flash)", for the activity log and answers. */
export function usedLabel(used: Set<string> | string[]): string {
  return [...used].join(", ");
}
/**
 * The estimating work (Estimator tab, setting up selections, send-off wording) runs on Claude with the estimating
 * skill whenever there's an Anthropic key, even when Gemini runs the everyday features.
 */
export const claudeOnlyReady = (hub: Hub) => !!hub.cfg.anthropicApiKey;

export function aiOffReason(hub: Hub): string {
  if (hub.cfg.ai?.provider === "gemini" || process.env.HUB_AI === "gemini") return "Gemini is off: add GEMINI_API_KEY to Keystone's .env (aistudio.google.com/apikey) and restart.";
  return "Everyday AI is off: add a free GEMINI_API_KEY to Keystone's .env (double-click Connect Gemini) and restart. The Claude API key is only used for estimating.";
}

/**
 * One question, one answer: plain text, or JSON shaped by `schema` (a JSON Schema). `fast` uses the quicker,
 * cheaper model (summaries, tasks from email).
 */
export async function complete<T = string>(hub: Hub, o: { system: string; prompt: string; schema?: Record<string, unknown>; fast?: boolean; images?: { mimeType: string; data: string }[]; /** Files uploaded with hub.gemini.uploadFile (recordings). */ files?: { mimeType: string; uri: string }[]; used?: Set<string> }): Promise<T> {
  const p = aiProvider(hub);
  if (p === "off") throw new Error(aiOffReason(hub));
  if (p === "gemini") {
    const parts = [{ text: o.prompt }, ...(o.images ?? []).map((im) => ({ inlineData: im })), ...(o.files ?? []).map((f) => ({ fileData: { mimeType: f.mimeType, fileUri: f.uri } }))];
    const r = await hub.gemini!.generate({ model: o.fast ? hub.cfg.ai.geminiFastModel : hub.cfg.ai.geminiModel, fallbackModels: o.fast ? [hub.cfg.ai.geminiModel, ...(hub.cfg.ai.geminiFallbacks ?? [])] : hub.cfg.ai.geminiFallbacks, system: o.system, contents: [{ role: "user", parts }], jsonSchema: o.schema });
    o.used?.add(`Gemini (${r.model ?? (o.fast ? hub.cfg.ai.geminiFastModel : hub.cfg.ai.geminiModel)})`);
    if (!o.schema) return r.text as T;
    try {
      return JSON.parse(r.text) as T;
    } catch {
      return JSON.parse(r.text.match(/\{[\s\S]*\}/)?.[0] ?? "{}") as T;
    }
  }
  if (o.images?.length || o.files?.length) throw new Error("Looking at pictures and listening to recordings needs Gemini (GEMINI_API_KEY).");
  o.used?.add(`Claude (${o.fast ? hub.cfg.fastModel : hub.cfg.model})`);
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
      env: claudeEnv(hub),
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
/** How long to wait before retrying a step when every Gemini model is busy (tests shorten it). */
export const BUSY_WAITS = [15_000, 45_000];

export interface ChatTurn {
  role: "user" | "assistant";
  text: string;
}

/** Earlier turns of an Ask conversation, as text in front of the new message (for the Claude path). */
export function withHistory(prompt: string, history: ChatTurn[] = []): string {
  if (!history.length) return prompt;
  const lines = history.map((t) => `${t.role === "user" ? "Hunter" : "You"}: ${t.text}`).join("\n\n");
  return `Earlier in this conversation:\n\n${lines}\n\nHunter's reply now: ${prompt}`;
}

export async function agentAsk(hub: Hub, prompt: string, opts: { jobNumber?: number; onMessage?: (m: SDKMessage) => void; maxSteps?: number; history?: ChatTurn[]; used?: Set<string> } = {}): Promise<string> {
  const p = aiProvider(hub);
  if (p === "off") throw new Error(aiOffReason(hub));
  if (p === "claude") {
    opts.used?.add(`Claude (${hub.cfg.model})`);
    return claudeAsk(hub, withHistory(prompt, opts.history), opts);
  }

  const defs = hubToolDefs(hub);
  const decls: FunctionDecl[] = defs.map((d: any) => ({ name: d.name, description: String(d.description).slice(0, 1000), parametersJsonSchema: toSchema(d.inputSchema) }));
  const system = `${systemPrompt(hub, opts.jobNumber)}

Right now it's ${new Date().toLocaleString("en-US", { timeZone: "America/Denver", weekday: "long", year: "numeric", month: "long", day: "numeric", hour: "numeric", minute: "2-digit" })} (Denver time). "Tomorrow", "this morning" and "next week" are relative to that.

You're running on Gemini inside Keystone. Use the functions provided for anything about jobs, email, the calendar, tasks, contacts and Homebase; read before you answer, and never guess job facts. You can't run the estimating skill or open files here: for estimating, pricing or revising an estimate, tell Hunter to use the Estimator tab. Email is drafts only.`;
  // An answer to a question it asked: the earlier turns come first, so it knows what "yes, the second one" means.
  const contents: Turn[] = [...(opts.history ?? []).map((t): Turn => ({ role: t.role === "user" ? "user" : "model", parts: [{ text: t.text }] })), { role: "user", parts: [{ text: prompt }] }];
  for (let step = 0; step < (opts.maxSteps ?? 24); step++) {
    compactOlder(contents);
    // Google's models get busy in bursts: when every model says so, wait and try the step again before giving up.
    let r: Awaited<ReturnType<NonNullable<Hub["gemini"]>["generate"]>> | undefined;
    for (let attempt = 0; !r; attempt++) {
      try {
        r = await hub.gemini!.generate({ model: hub.cfg.ai.geminiModel, fallbackModels: hub.cfg.ai.geminiFallbacks, system, contents, tools: decls });
      } catch (e) {
        if (attempt >= BUSY_WAITS.length || !/busy|unavailable|high demand|overloaded/i.test((e as Error).message)) throw e;
        hub.say(`  Gemini is busy; trying again in ${Math.round(BUSY_WAITS[attempt] / 1000)}s…`);
        await new Promise((res) => setTimeout(res, BUSY_WAITS[attempt]));
      }
    }
    opts.used?.add(`Gemini (${r.model ?? hub.cfg.ai.geminiModel})`);
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
