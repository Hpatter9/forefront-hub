import { readFileSync, statSync } from "node:fs";
import path from "node:path";
import type { Config } from "../../core/config.js";

/**
 * Google's Gemini, as Keystone's AI when HUB_AI=gemini (or when there's a Gemini key and no Anthropic one).
 * A thin client for generateContent: plain text, JSON shaped by a JSON Schema, and function calling (Keystone's
 * own tools). Free-tier keys come from aistudio.google.com/apikey. Keystone uses one free key only (FreeGemini
 * below picks the best model it answers on). On the free tier Google may use requests to improve its products.
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
}
export interface GenerateResult {
  /** The model's turn as-is (kept whole when it's sent back, as Gemini asks for function-call turns). */
  turn: Turn;
  text: string;
  calls: { name: string; args: Record<string, unknown>; id?: string }[];
  /** The model that actually answered (a fallback when the first was busy). */
  model?: string;
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
  /** How long a model may take to answer before it counts as busy (0: no limit). */
  timeoutMs = 150_000;
  /** FreeGemini turns this off: it moves on to the next model instead of waiting. */
  waitOnMinuteLimit = true;
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

  /** The models this key can see. */
  async listModels(): Promise<string[]> {
    const names: string[] = [];
    let page = "";
    for (let i = 0; i < 5; i++) {
      const r = await this.fetchFn(`${URL_BASE}?pageSize=200${page ? `&pageToken=${encodeURIComponent(page)}` : ""}`, { headers: { "x-goog-api-key": this.key } });
      const j: any = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(`Gemini: couldn't list models (${j?.error?.message ?? r.status})`);
      for (const m of j.models ?? []) if ((m.supportedGenerationMethods ?? []).includes("generateContent")) names.push(String(m.name));
      if (!j.nextPageToken) break;
      page = j.nextPageToken;
    }
    return names;
  }

  private async once(req: GenerateRequest): Promise<GenerateResult> {
    const body: Record<string, unknown> = { contents: req.contents };
    if (req.system) body.systemInstruction = { parts: [{ text: req.system }] };
    if (req.jsonSchema) body.generationConfig = { responseMimeType: "application/json", responseJsonSchema: req.jsonSchema };
    if (req.tools?.length) body.tools = [{ functionDeclarations: req.tools }];
    // Free-tier keys hit per-minute limits: wait as Google asks and try again (a few times).
    for (let attempt = 0; ; attempt++) {
      // A model that says nothing for this long is treated as busy (a streamed answer, like a long recording, has no limit).
      const r = await this.fetchFn(`${URL_BASE}/${encodeURIComponent(req.model)}:${req.stream ? "streamGenerateContent?alt=sse" : "generateContent"}`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-goog-api-key": this.key },
        body: JSON.stringify(body),
        ...(req.stream || !this.timeoutMs ? {} : { signal: AbortSignal.timeout(this.timeoutMs) }),
      }).catch((e: Error) => {
        if (/timeout|aborted/i.test(`${e.name} ${e.message}`)) throw new Error(`Gemini: ${req.model} is busy or unavailable (timed out after ${Math.round(this.timeoutMs / 1000)} seconds)`);
        throw e;
      });
      if (r.ok && req.stream) return toResult(joinStream(await r.text()));
      const j: any = await r.json().catch(() => ({}));
      if (r.ok) return toResult(j);
      const msg = j?.error?.message ?? `HTTP ${r.status}`;
      if (r.status === 429) {
        // Free-tier limits are per minute (requests or input tokens) and per day. A per-minute limit clears within
        // the minute, whatever "retry in 0.2s" says: wait it out once, then let the next model (its own quota) try.
        const daily = /per ?day|PerDay|daily/i.test(JSON.stringify(j));
        if (!daily && attempt < 1 && this.waitOnMinuteLimit) {
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

/**
 * Which Gemini models are worth trying, best first, from the names Google lists for the key. Only models that
 * answer text (and can use Keystone's tools) are kept: no speech, image, music, robot or research agents.
 * Gemini 4 and Pro-class models come before Flash; within a class, the newest version first; a "-latest" alias
 * after the numbered ones; Flash-Lite last.
 */
const NOT_TEXT = /tts|image|banana|lyria|robotics|computer-use|antigravity|deep-research|transcribe|omni|customtools|embedding|audio|live|veo|imagen|aqa|learnlm/i;
export function rankGeminiModels(names: string[]): { best: string[]; quick: string[] } {
  const ok = [...new Set(names.map((n) => n.replace(/^models\//, "")))].filter((n) => /^gemini-/.test(n) && !NOT_TEXT.test(n));
  const info = (n: string) => {
    const version = Number(n.match(/^gemini-(\d+(?:\.\d+)?)/)?.[1] ?? 0);
    const lite = /lite/.test(n), flash = /flash/.test(n);
    // Gemini 4's named models (Hydrogen, Argon, Neon, Carbon) are the top class; Hydrogen and Argon are the big ones.
    const cls = lite ? 1 : flash ? 2 : 3;
    const named = ["hydrogen", "argon", "neon", "carbon"].findIndex((x) => n.includes(x));
    return { version: version || (/latest/.test(n) ? 0.5 : 0), cls, named: named < 0 ? 9 : named, preview: /preview|exp/.test(n) ? 1 : 0, alias: /latest/.test(n) ? 1 : 0 };
  };
  const order = (a: string, b: string) => {
    const x = info(a), y = info(b);
    return y.cls - x.cls || x.alias - y.alias || y.version - x.version || x.named - y.named || x.preview - y.preview || a.localeCompare(b);
  };
  const byClass = [...ok].sort(order);
  // Bigger class first overall, but a much newer Flash beats an old Pro: Pro-class models older than the newest Flash
  // by a whole version drop below it.
  const newestFlash = Math.max(0, ...ok.filter((n) => info(n).cls === 2 && !info(n).alias).map((n) => info(n).version));
  const best = [...byClass.filter((n) => info(n).cls === 3 && (info(n).alias || info(n).version >= newestFlash - 0.5 || info(n).version >= 4)), ...byClass.filter((n) => info(n).cls === 2), ...byClass.filter((n) => info(n).cls === 3 && !(info(n).alias || info(n).version >= newestFlash - 0.5 || info(n).version >= 4)), ...byClass.filter((n) => info(n).cls === 1)];
  // Quick jobs (summaries, one-liners) skip the big models: newest Flash first, then Flash-Lite.
  const quick = [...byClass.filter((n) => info(n).cls === 2), ...byClass.filter((n) => info(n).cls === 1)];
  return { best, quick };
}

/** Used when Google's model list can't be read: what the free key answered on in November 2026, best first. */
export const DEFAULT_LADDER = {
  best: ["gemini-4-hydrogen", "gemini-4-argon", "gemini-4-neon", "gemini-4-carbon", "gemini-3.8-flash", "gemini-3.7-flash", "gemini-3.6-flash", "gemini-3.5-flash", "gemini-flash-latest", "gemini-3.5-flash-lite", "gemini-flash-lite-latest"],
  quick: ["gemini-3.8-flash", "gemini-3.7-flash", "gemini-3.6-flash", "gemini-3.5-flash", "gemini-flash-latest", "gemini-3.5-flash-lite", "gemini-flash-lite-latest"],
};

/** How long to leave a model alone after it couldn't answer, by what went wrong. */
export function restFor(message: string, now = new Date()): number {
  const min = 60_000;
  if (/daily quota/i.test(message)) {
    // Free-tier daily limits reset at midnight Pacific time.
    const pt = new Date(now.toLocaleString("en-US", { timeZone: "America/Los_Angeles" }));
    const midnight = new Date(pt); midnight.setHours(24, 0, 0, 0);
    return Math.max(30 * min, midnight.getTime() - pt.getTime());
  }
  if (/per-minute quota/i.test(message)) return 2 * min;
  if (/busy or unavailable|high demand|overloaded|timed out/i.test(message)) return 5 * min;
  if (/not found|no longer available/i.test(message)) return 24 * 60 * min;
  // Needs billing, not on the free tier, can't use tools or JSON: not today.
  return 6 * 60 * min;
}

/**
 * Keystone's Gemini: one free key, and always the best model it will answer on. Every request tries the models
 * best first and steps down when one is over its free limit, busy, retired or not offered on the free tier; a model
 * that couldn't answer is left alone for a while (until the daily limit resets, a few minutes when it was only
 * busy) so later requests don't wait on it again. Quick jobs use a ladder of Flash models only. If every model is
 * resting on a per-minute limit, it waits once and tries again.
 */
export class FreeGemini implements GeminiClient {
  readonly kind = "gemini" as const;
  private resting = new Map<string, { until: number; why: string }>();
  private ladder: { best: string[]; quick: string[]; at: number } | null = null;
  /** The model that answered last (shown in Keystone's status line). */
  lastModel = "";
  waitMs = 20_000;
  constructor(private inner: LiveGemini, private listModels: () => Promise<string[]> = () => inner.listModels()) {
    inner.waitOnMinuteLimit = false;
    // With other models to step down to, a silent one is given up on sooner.
    inner.timeoutMs = 60_000;
  }

  /** The ladder, from Google's own list for this key (read once a day). */
  async models(): Promise<{ best: string[]; quick: string[] }> {
    if (this.ladder && Date.now() - this.ladder.at < 24 * 3600_000) return this.ladder;
    let r = DEFAULT_LADDER;
    try {
      const ranked = rankGeminiModels(await this.listModels());
      if (ranked.best.length && ranked.quick.length) r = ranked;
    } catch { /* keep the default ladder */ }
    this.ladder = { ...r, at: Date.now() };
    return r;
  }

  /** What's resting and why, for the status line. */
  status(): { model: string; resting: { model: string; why: string; until: string }[] } {
    const now = Date.now();
    return { model: this.lastModel, resting: [...this.resting].filter(([, v]) => v.until > now).map(([model, v]) => ({ model, why: v.why, until: new Date(v.until).toISOString() })) };
  }

  async generate(req: GenerateRequest): Promise<GenerateResult> {
    const lad = await this.models();
    // A quick job asks for a Lite model by name; everything else gets the best ladder.
    const list = /lite/i.test(req.model) ? lad.quick : lad.best;
    let last: Error | null = null;
    for (let round = 0; round < 2; round++) {
      const now = Date.now();
      const open = list.filter((m) => (this.resting.get(m)?.until ?? 0) <= now);
      // Second round: only when everything left was waiting out a per-minute limit.
      if (round === 1) {
        const minute = list.filter((m) => /per-minute/i.test(this.resting.get(m)?.why ?? ""));
        if (!minute.length || open.length) break;
        await new Promise((res) => setTimeout(res, this.waitMs));
        minute.forEach((m) => this.resting.delete(m));
        open.push(...minute);
      }
      for (const model of open) {
        try {
          const r = await this.inner.generate({ ...req, model, fallbackModels: [] });
          this.lastModel = model;
          return { ...r, model };
        } catch (e) {
          last = e as Error;
          if (/didn't accept the Gemini API key/i.test(last.message)) throw last;
          this.resting.set(model, { until: Date.now() + restFor(last.message), why: last.message.slice(0, 200) });
        }
      }
    }
    throw last ?? new Error("Gemini: every free model is resting right now (over its free limit or busy). Try again in a few minutes.");
  }

  uploadFile(file: string, mimeType: string) { return this.inner.uploadFile(file, mimeType); }
}

export function makeGemini(cfg: Config): GeminiClient | null {
  return cfg.ai.geminiKey ? new FreeGemini(new LiveGemini(cfg.ai.geminiKey)) : null;
}
