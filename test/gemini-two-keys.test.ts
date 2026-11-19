import { describe, expect, it } from "vitest";
import { MockGemini, TieredGemini, makeGemini } from "../src/connectors/gemini/index.js";
import { loadConfig } from "../src/core/config.js";

const ask = (text = "hi", extra: object = {}) => ({ model: "gemini-3.5-flash", contents: [{ role: "user" as const, parts: [{ text }] }], ...extra });

describe("a free and a paid Gemini key side by side", () => {
  it("runs everyday work on the free key and heavy picks on the paid key", async () => {
    const free = new MockGemini(() => "from free"), paid = new MockGemini(() => "from paid");
    const g = new TieredGemini(free, paid);
    expect(await g.generate(ask())).toMatchObject({ text: "from free", key: "free" });
    expect(await g.generate(ask("estimate", { paid: true, model: "gemini-4-argon" }))).toMatchObject({ text: "from paid", key: "paid" });
    expect([free.requests.length, paid.requests.length]).toEqual([1, 1]);
  });

  it("moves to the paid key only when the free one can't answer, and says why", async () => {
    const free = new MockGemini(() => { throw new Error("Gemini: gemini-3.5-flash hit its daily quota"); }), paid = new MockGemini(() => "from paid");
    const g = new TieredGemini(free, paid);
    const why: string[] = [];
    g.onPaidFallback = (w) => why.push(w);
    expect(await g.generate(ask())).toMatchObject({ text: "from paid", key: "paid" });
    expect(why).toEqual(["Gemini: gemini-3.5-flash hit its daily quota"]);
    // Free only, when the paid fallback is turned off.
    await expect(new TieredGemini(free, paid, false).generate(ask())).rejects.toThrow(/daily quota/);
  });

  it("keeps a request with an uploaded recording on the key that uploaded it", async () => {
    const free = new MockGemini(() => "free read it"), paid = new MockGemini(() => "paid read it");
    const g = new TieredGemini(free, paid);
    const up = await g.uploadFile("/tmp/walk.m4a", "audio/mp4");
    const r = await g.generate({ model: "m", contents: [{ role: "user", parts: [{ fileData: { mimeType: up.mimeType, fileUri: up.uri } } as any] }] });
    expect(r).toMatchObject({ text: "free read it", key: "free" });
    expect(paid.requests).toHaveLength(0);
  });

  it("reads both keys from the settings, and one key works as before", () => {
    const both = loadConfig({ HUB_MODE: "mock", GEMINI_FREE_API_KEY: "free-k", GEMINI_API_KEY: "paid-k" }, "/tmp/ks-two");
    expect(both.ai).toMatchObject({ provider: "gemini", geminiKey: "free-k", geminiFreeKey: "free-k", geminiPaidKey: "paid-k", geminiPaidFallback: true });
    expect(makeGemini(both)).toBeInstanceOf(TieredGemini);
    const off = loadConfig({ HUB_MODE: "mock", GEMINI_FREE_API_KEY: "f", GEMINI_API_KEY: "p", GEMINI_PAID_FALLBACK: "off" }, "/tmp/ks-two");
    expect(off.ai.geminiPaidFallback).toBe(false);
    const one = loadConfig({ HUB_MODE: "mock", GEMINI_API_KEY: "only" }, "/tmp/ks-two");
    expect(one.ai).toMatchObject({ provider: "gemini", geminiKey: "only", geminiFreeKey: "" });
    expect(makeGemini(one)).not.toBeInstanceOf(TieredGemini);
    expect(loadConfig({ HUB_MODE: "mock", GEMINI_FREE_API_KEY: "f" }, "/tmp/ks-two").ai.provider).toBe("gemini");
  });
});
