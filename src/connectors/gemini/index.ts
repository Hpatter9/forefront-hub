import { recordGemini } from "../../workflows/spend.js";
import { readFileSync, statSync } from "node:fs";
import path from "node:path";
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
  /** Send the answer back as it's written (for long jobs like transcribing an hour of audio, which would time out otherwise). */
  stream?: boolean;
  /** Models to try in turn when the first is busy, gone or failing (Google retires and overloads models). */
  fallbackModels?: string[];
  /** Run on the paid key (a heavy model picked by name). Everyday work leaves this off and uses the free key first. */
  paid?: boolean;
}
export interface GenerateResult {
  /** The model's turn as-is (kept whole when it's sent back, as Gemini asks for function-call turns). */
  turn: Turn;
  text: string;
  calls: { name: string; args: Record<string, unknown>; id?: string }[];
  /** The model that actually answered (a fallback when the first was busy). */
  model?: string;
  /** Which key answered, when Keystone has both a free and a paid one. */
  key?: "free" | "paid";
  /** Tokens used, as Google reports them (output includes thinking). */
  usage?: { input: number; output: number };
}

export interface GeminiClient {
  readonly kind: "gemini" | "mock";
  generate(req: GenerateRequest): Promise<GenerateResult>;
  /** Uploads a file (a recording, a long PDF) for use in a request as { fileData: { mimeType, fileUri } }. Google keeps it 48 hours. */
  uploadFile(file: string, mimeType: string): Promise<{ uri: string; mimeType: string }>;
}

const URL_BASE = "https://generativelanguage.googleapis.com/v1beta/models";

export class LiveGemini implements GeminiClient {
  readonly kind = "gemini" as const;
  /** How long to wait out a per-minute limit before retrying (tests make it short). */
  minuteWaitMs = 20_000;
  /** How often to check an uploaded file that's still being processed. */
  pollMs = 2_000;
  constructor(private key: string, private fetchFn: typeof fetch = (...a) => fetch(...a)) {}

  async generate(req: GenerateRequest): Promise<GenerateResult> {
    const models = [req.model, ...(req.fallbackModels ?? [])].filter((m, i, a) => m && a.indexOf(m) === i);
    let last: Error | null = null;
    for (const model of models) {
      try {
        return { ...(await this.once({ ...req, model })), model };
      } catch (e) {
        last = e as Error;
        // Only a bad key stops here. Anything else (busy, retired, over quota, needs billing, not allowed on this
        // key) goes on to the next model, so everyday work lands on a free one that answers.
        if (/didn't accept the Gemini API key/i.test(last.message)) throw last;
      }
    }
    throw last ?? new Error("Gemini: no model to use.");
  }

  async uploadFile(file: string, mimeType: string): Promise<{ uri: string; mimeType: string }> {
    const size = statSync(file).size;
    const start = await this.fetchFn("https://generativelanguage.googleapis.com/upload/v1beta/files", {
      method: "POST",
      headers: { "x-goog-api-key": this.key, "X-Goog-Upload-Protocol": "resumable", "X-Goog-Upload-Command": "start", "X-Goog-Upload-Header-Content-Length": String(size), "X-Goog-Upload-Header-Content-Type": mimeType, "Content-Type": "application/json" },
      body: JSON.stringify({ file: { display_name: path.basename(file).slice(0, 80) } }),
    });
    const url = start.headers.get("x-goog-upload-url");
    if (!start.ok || !url) throw new Error(`Gemini: couldn't start the upload (${(await start.text().catch(() => "")).slice(0, 200) || start.status})`);
    const up = await this.fetchFn(url, { method: "POST", headers: { "Content-Length": String(size), "X-Goog-Upload-Offset": "0", "X-Goog-Upload-Command": "upload, finalize" }, body: readFileSync(file) });
    const j: any = await up.json().catch(() => ({}));
    if (!up.ok || !j?.file?.uri) throw new Error(`Gemini: the upload failed (${j?.error?.message ?? up.status})`);
    // Audio and video are processed before they can be used.
    let f = j.file;
    for (let i = 0; f.state === "PROCESSING" && i < 60; i++) {
      await new Promise((res) => setTimeout(res, this.pollMs));
      f = await (await this.fetchFn(`https://generativelanguage.googleapis.com/v1beta/${f.name}`, { headers: { "x-goog-api-key": this.key } })).json();
    }
    if (f.state && f.state !== "ACTIVE") throw new Error(`Gemini couldn't read that file (${f.state}).`);
    return { uri: f.uri, mimeType: f.mimeType ?? mimeType };
  }

  private async once(req: GenerateRequest): Promise<GenerateResult> {
    const body: Record<string, unknown> = { contents: req.contents };
    if (req.system) body.systemInstruction = { parts: [{ text: req.system }] };
    if (req.jsonSchema) body.generationConfig = { responseMimeType: "application/json", responseJsonSchema: req.jsonSchema };
    if (req.tools?.length) body.tools = [{ functionDeclarations: req.tools }];
    // Free-tier keys hit per-minute limits: wait as Google asks and try again (a few times).
    for (let attempt = 0; ; attempt++) {
      const r = await this.fetchFn(`${URL_BASE}/${encodeURIComponent(req.model)}:${req.stream ? "streamGenerateContent?alt=sse" : "generateContent"}`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-goog-api-key": this.key },
        body: JSON.stringify(body),
      });
      if (r.ok && req.stream) return toResult(joinStream(await r.text()));
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

/** A streamed answer ("data: {...}" lines) put back together as one response. */
export function joinStream(body: string): any {
  let text = "";
  let last: any = {};
  const others: Part[] = [];
  for (const line of body.split(/\r?\n/)) {
    if (!line.startsWith("data:")) continue;
    let j: any;
    try {
      j = JSON.parse(line.slice(5).trim());
    } catch {
      continue;
    }
    last = j;
    for (const p of j?.candidates?.[0]?.content?.parts ?? []) {
      if (typeof p.text === "string" && !p.thought) text += p.text;
      else if (!p.thought) others.push(p);
    }
  }
  const parts: Part[] = [...(text ? [{ text }] : []), ...others];
  return { ...last, candidates: [{ ...(last?.candidates?.[0] ?? {}), content: { role: "model", parts } }] };
}

function toResult(j: any): GenerateResult {
  const cand = j?.candidates?.[0];
  const parts: Part[] = cand?.content?.parts ?? [];
  if (!parts.length) {
    const why = cand?.finishReason || j?.promptFeedback?.blockReason || "no answer";
    throw new Error(`Gemini gave no answer (${why}).`);
  }
  const u = j?.usageMetadata;
  return {
    ...(u ? { usage: { input: Number(u.promptTokenCount) || 0, output: (Number(u.candidatesTokenCount) || 0) + (Number(u.thoughtsTokenCount) || 0) } } : {}),
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
  uploads: string[] = [];
  async uploadFile(file: string, mimeType: string) {
    this.uploads.push(file);
    return { uri: `mock://${path.basename(file)}`, mimeType };
  }
  async generate(req: GenerateRequest): Promise<GenerateResult> {
    this.requests.push(structuredClone(req));
    const out = this.script(req, this.requests.length - 1);
    const r = typeof out === "string" ? { text: out } : out;
    const calls = r.calls ?? [];
    const text = r.text ?? "";
    return { text, calls, model: req.model, turn: r.turn ?? { role: "model", parts: [...(text ? [{ text }] : []), ...calls.map((c) => ({ functionCall: { name: c.name, args: c.args } }))] } };
  }
}

/** Counts what each answer cost (spend.ts), whichever feature asked. */
export class MeteredGemini implements GeminiClient {
  get kind() { return this.inner.kind; }
  constructor(private inner: GeminiClient, private stateDir: string) {}
  async generate(req: GenerateRequest): Promise<GenerateResult> {
    const r = await this.inner.generate(req);
    if (r.usage) recordGemini(this.stateDir, r.model ?? req.model, r.usage.input, r.usage.output);
    return r;
  }
  uploadFile(file: string, mimeType: string) { return this.inner.uploadFile(file, mimeType); }
}

/**
 * Two keys, so nothing has to be swapped: everyday work goes to the free key (no cost, daily limits) and moves to
 * the paid key only when the free one can't answer (used up for the day, down); heavy models picked by name
 * (`paid: true`) go straight to the paid key. A file uploaded for a request lives with the key that uploaded it, so
 * a request that carries one stays on that key. `paidFallback: false` keeps everyday work free-only.
 */
export class TieredGemini implements GeminiClient {
  private uploads = new Map<string, "free" | "paid">();
  /** Called once each time everyday work has to move to the paid key (so Hunter can be told). */
  onPaidFallback?: (why: string) => void;
  constructor(private free: GeminiClient, private paid: GeminiClient, private paidFallback = true) {}
  get kind() { return this.free.kind; }

  private keyOfFiles(req: GenerateRequest): "free" | "paid" | null {
    for (const t of req.contents) for (const p of t.parts) { const u = (p as { fileData?: { fileUri?: string } }).fileData?.fileUri; if (u && this.uploads.has(u)) return this.uploads.get(u)!; }
    return null;
  }

  async generate(req: GenerateRequest): Promise<GenerateResult> {
    const pinned = this.keyOfFiles(req);
    if (req.paid || pinned === "paid") return { ...(await this.paid.generate(req)), key: "paid" };
    try {
      return { ...(await this.free.generate(req)), key: "free" };
    } catch (e) {
      if (!this.paidFallback || pinned === "free") throw e;
      this.onPaidFallback?.((e as Error).message);
      return { ...(await this.paid.generate(req)), key: "paid" };
    }
  }

  async uploadFile(file: string, mimeType: string) {
    try {
      const r = await this.free.uploadFile(file, mimeType);
      this.uploads.set(r.uri, "free");
      return r;
    } catch (e) {
      if (!this.paidFallback) throw e;
      const r = await this.paid.uploadFile(file, mimeType);
      this.uploads.set(r.uri, "paid");
      return r;
    }
  }
}

export function makeGemini(cfg: Config): GeminiClient | null {
  const { geminiFreeKey: free, geminiPaidKey: paid } = cfg.ai;
  // Both: free first, paid behind it (only the paid key's use is counted as spending).
  if (free && paid) return new TieredGemini(new LiveGemini(free), new MeteredGemini(new LiveGemini(paid), cfg.stateDir), cfg.ai.geminiPaidFallback !== false);
  if (free) return new LiveGemini(free);
  return paid ? new MeteredGemini(new LiveGemini(paid), cfg.stateDir) : null;
}
