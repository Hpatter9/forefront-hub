import { afterEach, describe, expect, it } from "vitest";
import { claudeEndpoint, claudeEnv, ignoredRedirects } from "../src/agent/env.js";
import { testHub } from "./helpers.js";

const keep = { ...process.env };
afterEach(() => {
  for (const k of Object.keys(process.env)) if (!(k in keep)) delete process.env[k];
  Object.assign(process.env, keep);
});

describe("where Keystone's Claude requests go", () => {
  it("ignores a redirect set on the PC and goes to Anthropic with Keystone's key", () => {
    delete process.env.HUB_ALLOW_CLAUDE_REDIRECT;
    delete process.env.HUB_CLAUDE_BASE_URL;
    process.env.ANTHROPIC_BASE_URL = "http://127.0.0.1:3456/chatgpt-router";
    process.env.ANTHROPIC_AUTH_TOKEN = "router-token";
    const { hub } = testHub();
    hub.cfg.anthropicApiKey = "sk-ant-keystone";
    const env = claudeEnv(hub);
    expect(env.ANTHROPIC_BASE_URL).toBeUndefined();
    expect(env.ANTHROPIC_AUTH_TOKEN).toBeUndefined();
    expect(env.ANTHROPIC_API_KEY).toBe("sk-ant-keystone");
    expect(claudeEndpoint()).toBe("https://api.anthropic.com");
    expect(ignoredRedirects().map((r) => r.name)).toEqual(["ANTHROPIC_BASE_URL", "ANTHROPIC_AUTH_TOKEN"]);
    expect(ignoredRedirects()[0].host).toBe("127.0.0.1:3456");
  });
  it("uses an endpoint only when Keystone's own settings ask for it", () => {
    process.env.ANTHROPIC_BASE_URL = "http://elsewhere.example";
    process.env.HUB_CLAUDE_BASE_URL = "https://my-proxy.example";
    const { hub } = testHub();
    expect(claudeEnv(hub).ANTHROPIC_BASE_URL).toBe("https://my-proxy.example");
    process.env.HUB_ALLOW_CLAUDE_REDIRECT = "1";
    delete process.env.HUB_CLAUDE_BASE_URL;
    expect(claudeEnv(hub).ANTHROPIC_BASE_URL).toBe("http://elsewhere.example");
  });
});
