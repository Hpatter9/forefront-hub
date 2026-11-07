import type { Hub } from "../hub.js";

/**
 * The environment Keystone gives Claude. Claude's tools obey settings like ANTHROPIC_BASE_URL that send every
 * request to another server; add-ons that run "Claude Code with ChatGPT" (or another model) set them system-wide.
 * Keystone ignores any it inherits from the PC, so its requests (with your email and job data) go to Anthropic
 * unless you choose otherwise in Keystone's own .env: HUB_CLAUDE_BASE_URL=<url> to use a specific endpoint, or
 * HUB_ALLOW_CLAUDE_REDIRECT=1 to keep whatever the PC sets.
 */
export const REDIRECT_VARS = [
  "ANTHROPIC_BASE_URL",
  "ANTHROPIC_AUTH_TOKEN",
  "ANTHROPIC_CUSTOM_HEADERS",
  "ANTHROPIC_MODEL",
  "ANTHROPIC_SMALL_FAST_MODEL",
  "ANTHROPIC_DEFAULT_OPUS_MODEL",
  "ANTHROPIC_DEFAULT_SONNET_MODEL",
  "ANTHROPIC_DEFAULT_HAIKU_MODEL",
  "CLAUDE_CODE_SUBAGENT_MODEL",
  "CLAUDE_CODE_USE_BEDROCK",
  "CLAUDE_CODE_USE_VERTEX",
  "CLAUDE_CODE_USE_FOUNDRY",
  "ANTHROPIC_BEDROCK_BASE_URL",
  "ANTHROPIC_VERTEX_BASE_URL",
  "ANTHROPIC_FOUNDRY_BASE_URL",
];

const allowAll = () => process.env.HUB_ALLOW_CLAUDE_REDIRECT === "1";

/** Redirect settings found on this PC that Keystone is ignoring (names and the host they point to). */
export function ignoredRedirects(env: NodeJS.ProcessEnv = process.env): { name: string; host: string }[] {
  if (allowAll()) return [];
  return REDIRECT_VARS.filter((k) => (env[k] ?? "").trim()).map((k) => {
    const v = String(env[k]);
    let host = "";
    try {
      host = /^https?:\/\//i.test(v) ? new URL(v).host : "";
    } catch {
      host = "";
    }
    return { name: k, host };
  });
}

/** Where Claude requests go. */
export function claudeEndpoint(): string {
  const own = process.env.HUB_CLAUDE_BASE_URL?.trim();
  if (own) return own;
  if (allowAll() && process.env.ANTHROPIC_BASE_URL) return process.env.ANTHROPIC_BASE_URL;
  return "https://api.anthropic.com";
}

export function claudeEnv(hub: Hub): Record<string, string> {
  const env = { ...(process.env as Record<string, string>) };
  if (!allowAll()) for (const k of REDIRECT_VARS) delete env[k];
  const own = process.env.HUB_CLAUDE_BASE_URL?.trim();
  if (own) env.ANTHROPIC_BASE_URL = own;
  if (hub.cfg.anthropicApiKey) env.ANTHROPIC_API_KEY = hub.cfg.anthropicApiKey;
  return env;
}
