import type { Config } from "../../core/config.js";

/**
 * Google's Gemini, as Keystone's AI when HUB_AI=gemini (or when there's a Gemini key and no Anthropic one).
 * A thin client for generateContent: plain text, JSON shaped by a JSON Schema, and function calling (Keystone's
 * own tools). Free-tier keys come from aistudio.google.com/apikey. On the free tier Google may use requests to
 * improve its products; a paid (billing-enabled) key doesn't.
 */
export interface Part {
  text?: string;
  functionCall?: { name: string; args?: Record<string, unknown>; id?: string };
  functionResponse?: { name: string; response: Record<string, unknown>; id?: string };
  thoughtSignature?: string;
  [k: string]: unknown;
}
export interface Turn {
  role: "user" | "model";
  parts: Part[];
}
export interface FunctionDecl {
  name: string;
  description: string;
  parametersJsonSchema?: Record<string, unknown>;
}
export interface GenerateRequest {
  model: string;
  system?: string;
  contents: Turn[];
  /** Answer as JSON matching this JSON Schema. */
  jsonSchema?: Record<string, unknown>;
  tools?: FunctionDecl[];
  /** Models to try in turn when the first is busy, gone or failing (Google retires and overloads models). */
  fallbackModels?: string[];
}
export interface GenerateResult {
  /** The model's turn as-is (kept whole when it's sent back, as Gemini asks for function-call turns). */
  turn: Turn;
  text: string;
  calls: { name: string; args: Record<string, unknown>; id?: string }[];
  /** The model that actually answered (a fallback when the first was busy). */
  model?: string;
}

export interface GeminiClient {
  readonly kind: "gemini" | "mock";
  generate(req: GenerateRequest): Promise<GenerateResult>;
}

const URL_BASE = "https://generativelanguage.googleapis.com/v1beta/models";

export class LiveGemini implements GeminiClient {
  readonly kind = "gemini" as const;
  /** How long to wait out a per-minute limit before retrying (tests make it short). */
  minuteWaitMs = 20_000;
  constructor(private key: string, private fetchFn: typeof fetch = (...a) => fetch(...a)) {}

  async generate(req: GenerateRequest): Promise<GenerateResult> {
    const models = [req.model, ...(req.fallbackModels ?? [])].filter((m, i, a) => m && a.indexOf(m) === i);
    let last: Error | null = null;
    for (const model of models) {
      try {
        return { ...(await this.once({ ...req, model })), model };
      } catch (e) {
        last = e as Error;
        // A bad key or a malformed request won't get better on another model.
        if (!/busy|unavailable|no longer available|not found|high demand|overloaded|quota|rate limit/i.test(last.message)) throw last;
      }
    }
    throw last ?? new Error("Gemini: no model to use.");
  }

  private async once(req: GenerateRequest): Promise<GenerateResult> {
    const body: Record<string, unknown> = { contents: req.contents };
    if (req.system) body.systemInstruction = { parts: [{ text: req.system }] };
    if (req.jsonSchema) body.generationConfig = { responseMimeType: "application/json", responseJsonSchema: req.jsonSchema };
    if (req.tools?.length) body.tools = [{ functionDeclarations: req.tools }];
    // Free-tier keys hit per-minute limits: wait as Google asks and try again (a few times).
    for (let attempt = 0; ; attempt++) {
      const r = await this.fetchFn(`${URL_BASE}/${encodeURIComponent(req.model)}:generateContent`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-goog-api-key": this.key },
        body: JSON.stringify(body),
      });
      const j: any = await r.json().catch(() => ({}));
      if (r.ok) return toResult(j);
      const msg = j?.error?.message ?? `HTTP ${r.status}`;
      if (r.status === 429) {
        // Free-tier limits are per minute (requests or input tokens) and per day. A per-minute limit clears within
        // the minute, whatever "retry in 0.2s" says: wait it out once, then let the next model (its own quota) try.
        const daily = /per ?day|PerDay|daily/i.test(JSON.stringify(j));
        if (!daily && attempt < 1) {
          const hint = Number(String(j?.error?.details?.find?.((d: any) => d.retryDelay)?.retryDelay ?? "").match(/([\d.]+)s/)?.[1] ?? 0);
          await new Promise((res) => setTimeout(res, Math.min(65_000, Math.max(this.minuteWaitMs, hint * 1000))));
          continue;
        }
        throw new Error(`Gemini: ${req.model} hit its ${daily ? "daily" : "per-minute"} quota (${msg.split("\n")[0]})`);
      }
      if (r.status >= 500 && attempt < 1) {
        await new Promise((res) => setTimeout(res, 3000));
        continue;
      }
      if (r.status === 400 && /api key not valid|API_KEY_INVALID/i.test(msg)) throw new Error("Google didn't accept the Gemini API key (GEMINI_API_KEY in Keystone's .env).");
      if (r.status === 404) throw new Error(`Gemini: model ${req.model} not found or no longer available (${msg})`);
      if (r.status >= 500) throw new Error(`Gemini: ${req.model} is busy or unavailable (${msg})`);
      throw new Error(`Gemini: ${msg}`);
    }
  }
}

function toResult(j: any): GenerateResult {
  const cand = j?.candidates?.[0];
  const parts: Part[] = cand?.content?.parts ?? [];
  if (!parts.length) {
    const why = cand?.finishReason || j?.promptFeedback?.blockReason || "no answer";
    throw new Error(`Gemini gave no answer (${why}).`);
  }
  return {
    turn: { role: "model", parts },
    text: parts.filter((p) => typeof p.text === "string" && !p.thought).map((p) => p.text).join("").trim(),
    calls: parts.filter((p) => p.functionCall).map((p) => ({ name: p.functionCall!.name, args: p.functionCall!.args ?? {}, id: p.functionCall!.id })),
  };
}

/** For tests: answers from a script, and remembers what it was asked. */
export class MockGemini implements GeminiClient {
  readonly kind = "mock" as const;
  requests: GenerateRequest[] = [];
  constructor(private script: (req: GenerateRequest, n: number) => Partial<GenerateResult> | string = () => "") {}
  async generate(req: GenerateRequest): Promise<GenerateResult> {
    this.requests.push(structuredClone(req));
    const out = this.script(req, this.requests.length - 1);
    const r = typeof out === "string" ? { text: out } : out;
    const calls = r.calls ?? [];
    const text = r.text ?? "";
    return { text, calls, model: req.model, turn: r.turn ?? { role: "model", parts: [...(text ? [{ text }] : []), ...calls.map((c) => ({ functionCall: { name: c.name, args: c.args } }))] } };
  }
}

export function makeGemini(cfg: Config): GeminiClient | null {
  return cfg.ai.geminiKey ? new LiveGemini(cfg.ai.geminiKey) : null;
}
