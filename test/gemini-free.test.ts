import { describe, expect, it } from "vitest";
import { FreeGemini, LiveGemini, makeGemini, rankGeminiModels, restFor } from "../src/connectors/gemini/index.js";
import { loadConfig } from "../src/core/config.js";

const ok = (text = "ok") => new Response(JSON.stringify({ candidates: [{ content: { role: "model", parts: [{ text }] } }] }), { status: 200 });
const err = (status: number, message: string, extra: object = {}) => new Response(JSON.stringify({ error: { code: status, message, ...extra } }), { status });
const ask = (model = "gemini-3.5-flash") => ({ model, system: "s", contents: [{ role: "user" as const, parts: [{ text: "hi" }] }] });

/** A key whose models answer as `answer` says, counting every call. */
function keyWith(answer: Record<string, () => Response>, list = Object.keys(answer)) {
  const asked: string[] = [];
  const fetchFn = (async (url: string) => {
    if (/models\?pageSize/.test(String(url))) return new Response(JSON.stringify({ models: list.map((n) => ({ name: `models/${n}`, supportedGenerationMethods: ["generateContent"] })) }), { status: 200 });
    const model = String(url).match(/models\/([^:]+):/)![1];
    asked.push(model);
    return (answer[model] ?? (() => err(404, "not found")))();
  }) as typeof fetch;
  return { asked, gemini: new FreeGemini(new LiveGemini("free-key", fetchFn)) };
}

describe("Gemini runs on the free key only, on the best model it answers on", () => {
  it("uses one key: the free one, else the old GEMINI_API_KEY, and flags that", () => {
    const both = loadConfig({ HUB_MODE: "mock", GEMINI_FREE_API_KEY: "free", GEMINI_API_KEY: "paid" }, "/tmp/ks-free");
    expect(both.ai).toMatchObject({ provider: "gemini", geminiKey: "free", geminiKeyNotMarkedFree: false });
    const old = loadConfig({ HUB_MODE: "mock", GEMINI_API_KEY: "only" }, "/tmp/ks-free");
    expect(old.ai).toMatchObject({ geminiKey: "only", geminiKeyNotMarkedFree: true });
    expect(makeGemini(both)).toBeInstanceOf(FreeGemini);
    expect(makeGemini(loadConfig({ HUB_MODE: "mock" }, "/tmp/ks-free"))).toBeNull();
  });

  it("ranks Google's list best first and leaves out speech, image and agent models", () => {
    const r = rankGeminiModels(["models/gemini-3.5-flash", "models/gemini-4-argon", "models/gemini-3.8-flash", "models/gemini-4-hydrogen", "models/gemini-2.5-pro", "models/gemini-3.1-pro-preview",
      "models/gemini-flash-latest", "models/gemini-3.5-flash-lite", "models/gemini-3.8-flash-tts", "models/gemini-3-pro-image", "models/deep-research-preview-04-2026", "models/gemma-4-31b-it", "models/gemini-flash-lite-latest"]);
    expect(r.best).toEqual(["gemini-4-hydrogen", "gemini-4-argon", "gemini-3.8-flash", "gemini-3.5-flash", "gemini-flash-latest", "gemini-3.1-pro-preview", "gemini-2.5-pro", "gemini-3.5-flash-lite", "gemini-flash-lite-latest"]);
    expect(r.quick).toEqual(["gemini-3.8-flash", "gemini-3.5-flash", "gemini-flash-latest", "gemini-3.5-flash-lite", "gemini-flash-lite-latest"]);
  });

  it("steps down past models over their free limit or busy, then leaves them alone for a while", async () => {
    const { asked, gemini } = keyWith({
      "gemini-4-hydrogen": () => err(429, "quota", { details: [{ violations: [{ quotaId: "GenerateRequestsPerDayPerProjectPerModel-FreeTier" }] }] }),
      "gemini-3.8-flash": () => err(503, "This model is currently experiencing high demand."),
      "gemini-3.5-flash": () => ok("from 3.5"),
      "gemini-3.5-flash-lite": () => ok("from lite"),
    });
    expect(await gemini.generate(ask())).toMatchObject({ text: "from 3.5", model: "gemini-3.5-flash" });
    expect(asked).toEqual(["gemini-4-hydrogen", "gemini-3.8-flash", "gemini-3.8-flash", "gemini-3.5-flash"]); // a 503 is retried once
    asked.length = 0;
    // The next request goes straight to the model that answered.
    expect(await gemini.generate(ask())).toMatchObject({ model: "gemini-3.5-flash" });
    expect(asked).toEqual(["gemini-3.5-flash"]);
    expect(gemini.status().resting.map((r) => r.model)).toEqual(["gemini-4-hydrogen", "gemini-3.8-flash"]);
    // A quick job uses the Flash ladder only.
    asked.length = 0;
    expect(await gemini.generate(ask("gemini-flash-lite-latest"))).toMatchObject({ model: "gemini-3.5-flash" });
    expect(asked).toEqual(["gemini-3.5-flash"]);
  }, 20_000);

  it("stops at once for a bad key", async () => {
    const { asked, gemini } = keyWith({ "gemini-4-hydrogen": () => err(400, "API key not valid."), "gemini-3.5-flash": () => ok() });
    await expect(gemini.generate(ask())).rejects.toThrow(/didn't accept the Gemini API key/);
    expect(asked).toEqual(["gemini-4-hydrogen"]);
  });

  it("rests a model until the free daily limit resets, a few minutes when it was only busy", () => {
    const at = new Date("2026-11-25T20:00:00Z"); // noon Pacific
    expect(Math.round(restFor("Gemini: m hit its daily quota (x)", at) / 3600_000)).toBe(12);
    expect(restFor("Gemini: m hit its per-minute quota (x)", at)).toBe(120_000);
    expect(restFor("Gemini: m is busy or unavailable (x)", at)).toBe(300_000);
    expect(restFor("Gemini: model m not found or no longer available (x)", at)).toBe(86_400_000);
  });
});
