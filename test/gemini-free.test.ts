import { describe, expect, it } from "vitest";
import { LiveGemini } from "../src/connectors/gemini/index.js";
import { FREE_GEMINI, isFreeGemini, loadConfig } from "../src/core/config.js";

describe("everyday work stays on the free Gemini models", () => {
  it("ignores a heavy model set in .env and always has the free ones to fall back on", () => {
    const heavy = loadConfig({ HUB_MODE: "mock", GEMINI_API_KEY: "k", GEMINI_MODEL: "gemini-4-argon", GEMINI_FAST_MODEL: "gemini-4-hydrogen", GEMINI_FALLBACK_MODELS: "gemini-3.5-pro, gemini-flash-latest" }, "/tmp/ks-free");
    expect(heavy.ai.geminiModel).toBe("gemini-3.5-flash");
    expect(heavy.ai.geminiFastModel).toBe("gemini-flash-lite-latest");
    expect(heavy.ai.geminiIgnored).toEqual(["gemini-4-argon", "gemini-4-hydrogen"]);
    expect(heavy.ai.geminiFallbacks).toEqual(["gemini-flash-latest", "gemini-3.5-flash", "gemini-flash-lite-latest"]);
    const plain = loadConfig({ HUB_MODE: "mock", GEMINI_API_KEY: "k" }, "/tmp/ks-free");
    expect(plain.ai).toMatchObject({ geminiModel: "gemini-3.5-flash", geminiFastModel: "gemini-flash-lite-latest", geminiIgnored: [], geminiFallbacks: FREE_GEMINI });
    const own = loadConfig({ HUB_MODE: "mock", GEMINI_API_KEY: "k", GEMINI_MODEL: "gemini-3.8-flash" }, "/tmp/ks-free");
    expect(own.ai.geminiModel).toBe("gemini-3.8-flash"); // another free Flash model is fine
    expect([isFreeGemini("gemini-3.5-flash-lite"), isFreeGemini("gemini-3-pro"), isFreeGemini("gemini-3.1-flash-image")]).toEqual([true, false, false]);
  });

  it("moves on to the next model when one needs billing or isn't allowed, and stops only for a bad key", async () => {
    const asked: string[] = [];
    const fake = (async (url: string) => {
      const model = String(url).match(/models\/([^:]+):/)![1];
      asked.push(model);
      if (model === "paid-model") return new Response(JSON.stringify({ error: { code: 403, message: "Billing must be enabled for this model." } }), { status: 403 });
      if (model === "odd-model") return new Response(JSON.stringify({ error: { code: 400, message: "This model does not support function calling." } }), { status: 400 });
      return new Response(JSON.stringify({ candidates: [{ content: { role: "model", parts: [{ text: "ok" }] } }] }), { status: 200 });
    }) as typeof fetch;
    const g = new LiveGemini("k", fake);
    const r = await g.generate({ model: "paid-model", fallbackModels: ["odd-model", "gemini-3.5-flash"], system: "s", contents: [{ role: "user", parts: [{ text: "hi" }] }] });
    expect(r).toMatchObject({ text: "ok", model: "gemini-3.5-flash" });
    expect(asked).toEqual(["paid-model", "odd-model", "gemini-3.5-flash"]);
    const bad = new LiveGemini("k", (async () => new Response(JSON.stringify({ error: { code: 400, message: "API key not valid." } }), { status: 400 })) as typeof fetch);
    let n = 0;
    (bad as any).fetchFn = (async (...a: any[]) => { n++; return new Response(JSON.stringify({ error: { code: 400, message: "API key not valid." } }), { status: 400 }); }) as typeof fetch;
    await expect(bad.generate({ model: "a", fallbackModels: ["b", "c"], system: "s", contents: [] })).rejects.toThrow(/didn't accept the Gemini API key/);
    expect(n).toBe(1);
  });
});
