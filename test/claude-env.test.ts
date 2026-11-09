import { afterEach, describe, expect, it } from "vitest";
import { claudeEnv, ignoredRedirects } from "../src/agent/env.js";
import { claudeOnlyReady } from "../src/agent/llm.js";

const hub = (key: string, provider = "gemini") => ({ cfg: { anthropicApiKey: key, ai: { provider } } }) as any;
const saved = { ...process.env };
afterEach(() => {
  for (const k of Object.keys(process.env)) if (!(k in saved)) delete process.env[k];
  Object.assign(process.env, saved);
});

describe("Claude for estimating", () => {
  it("runs the estimating work on Claude whenever there's a key, even with Gemini on the everyday features", () => {
    expect(claudeOnlyReady(hub("sk-ant-x", "gemini"))).toBe(true);
    expect(claudeOnlyReady(hub("", "gemini"))).toBe(false);
  });

  it("ignores a PC-wide redirect (like a ChatGPT bridge) and uses Keystone's key", () => {
    process.env.ANTHROPIC_BASE_URL = "http://127.0.0.1:9999/bridge";
    process.env.ANTHROPIC_API_KEY = "fake-bridge-key";
    delete process.env.HUB_ALLOW_CLAUDE_REDIRECT;
    delete process.env.HUB_CLAUDE_BASE_URL;
    const env = claudeEnv(hub("sk-ant-real"));
    expect(env.ANTHROPIC_BASE_URL).toBeUndefined();
    expect(env.ANTHROPIC_API_KEY).toBe("sk-ant-real");
    expect(ignoredRedirects()).toEqual([{ name: "ANTHROPIC_BASE_URL", host: "127.0.0.1:9999" }]);
  });

  it("keeps the redirect when Keystone's .env says to", () => {
    process.env.ANTHROPIC_BASE_URL = "http://127.0.0.1:9999/bridge";
    process.env.HUB_ALLOW_CLAUDE_REDIRECT = "1";
    expect(claudeEnv(hub("sk-ant-real")).ANTHROPIC_BASE_URL).toBe("http://127.0.0.1:9999/bridge");
  });
});
