import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import dotenv from "dotenv";

export const HUB_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

export type Mode = "mock" | "live";

export interface Config {
  hubRoot: string;
  mode: Mode;
  estimatorDir: string;
  skillDir: string;
  jobsRoot: string;
  python: string;
  anthropicApiKey: string;
  /**
   * Which AI runs Keystone's AI features. HUB_AI=gemini | claude | off; when it isn't set: Gemini if there's a
   * GEMINI_API_KEY, else Claude if there's an Anthropic key, else off. The Estimator tab and setting up
   * selections use the Claude-only estimating skill, so they need Claude.
   */
  ai: { provider: "claude" | "gemini" | "off"; geminiKey: string; geminiModel: string; geminiFastModel: string; geminiFallbacks?: string[] };
  model: string;
  /** A fast, cheaper model for small jobs like one-line email summaries. */
  fastModel: string;
  homebase: { driver: "mock" | "browser" | "api"; url: string; apiToken: string; authFile: string; me: string };
  gmail: { driver: "mock" | "google"; clientId: string; clientSecret: string; address: string; tokenFile: string };
  companycam: { driver: "mock" | "rest"; token: string };
  docusketch: { downloadsDir: string };
  spotify: { clientId: string };
  /** Drive times for calendar events: where the day's driving starts. */
  travel: { start: string };
  /** Where mocks keep their state (mock outbox, mock Homebase writes). */
  stateDir: string;
}

/** Reads .env from the Keystone folder (never committed) and fills in defaults. Mock wherever credentials are missing. */
export function loadConfig(env: NodeJS.ProcessEnv = process.env, root = HUB_ROOT): Config {
  if (env === process.env) dotenv.config({ path: path.join(root, ".env"), quiet: true } as dotenv.DotenvConfigOptions);
  const e = (k: string, d = "") => (env[k] ?? "").trim() || d;
  const mode: Mode = e("HUB_MODE", "live") === "mock" ? "mock" : "live";
  const live = mode === "live";
  const isWin = process.platform === "win32";

  const estimatorDir = e("ESTIMATOR_DIR", isWin ? "C:\\Games\\Estimator" : path.join(root, "..", "estimator"));
  const skillDir = e("SKILL_DIR", path.join(estimatorDir, "skill", "forefront-estimate"));
  const stateDir = path.join(root, ".hub");

  let anthropicApiKey = e("ANTHROPIC_API_KEY");
  const keyFile = path.join(estimatorDir, "data", "api_key.txt");
  if (!anthropicApiKey && existsSync(keyFile)) anthropicApiKey = readFileSync(keyFile, "utf8").trim();

  const hbDriver = e("HOMEBASE_DRIVER", e("HOMEBASE_API_TOKEN") ? "api" : "browser") as Config["homebase"]["driver"];
  const gmailReady = !!(e("GOOGLE_CLIENT_ID") && e("GOOGLE_CLIENT_SECRET"));
  const ccToken = e("COMPANYCAM_TOKEN");

  return {
    hubRoot: root,
    mode,
    estimatorDir,
    skillDir,
    jobsRoot: e("JOBS_ROOT", live ? (isWin ? "C:\\Jobs" : path.join(root, "jobs")) : path.join(stateDir, "jobs")),
    python: e("PYTHON", isWin ? "py" : "python3"),
    anthropicApiKey,
    ai: (() => {
      const geminiKey = e("GEMINI_API_KEY", e("GOOGLE_API_KEY"));
      const want = e("HUB_AI").toLowerCase();
      const provider: Config["ai"]["provider"] =
        want === "off" ? "off" : want === "gemini" ? (geminiKey ? "gemini" : "off") : want === "claude" ? (anthropicApiKey ? "claude" : "off") : geminiKey ? "gemini" : anthropicApiKey ? "claude" : "off";
      return {
        provider,
        geminiKey,
        geminiModel: e("GEMINI_MODEL", "gemini-3.5-flash"),
        geminiFastModel: e("GEMINI_FAST_MODEL", "gemini-flash-lite-latest"),
        // Tried in turn when a model is busy or retired.
        geminiFallbacks: e("GEMINI_FALLBACK_MODELS", "gemini-flash-latest,gemini-flash-lite-latest").split(",").map((x) => x.trim()).filter(Boolean),
      };
    })(),
    model: e("HUB_MODEL", "claude-opus-5-5"),
    fastModel: e("HUB_FAST_MODEL", "claude-haiku-5-5"),
    homebase: {
      driver: !live ? "mock" : hbDriver === "api" && !e("HOMEBASE_API_TOKEN") ? "mock" : hbDriver,
      url: e("HOMEBASE_URL", "https://homebase.forefrontteam.com").replace(/\/$/, ""),
      apiToken: e("HOMEBASE_API_TOKEN"),
      authFile: path.join(root, "auth", "homebase.json"),
      me: e("HOMEBASE_ME", "Hunter Patterson"),
    },
    gmail: {
      driver: live && gmailReady ? "google" : "mock",
      clientId: e("GOOGLE_CLIENT_ID"),
      clientSecret: e("GOOGLE_CLIENT_SECRET"),
      address: e("GMAIL_ADDRESS", "hunter@forefrontteam.com"),
      tokenFile: path.join(root, "auth", "google-token.json"),
    },
    companycam: { driver: live && ccToken ? "rest" : "mock", token: ccToken },
    spotify: { clientId: e("SPOTIFY_CLIENT_ID") },
    travel: { start: e("HUB_DAY_START_ADDRESS", officeAddress(skillDir)) },
    docusketch: { downloadsDir: e("DOWNLOADS_DIR", path.join(env.USERPROFILE || env.HOME || root, "Downloads")) },
    stateDir,
  };
}

/** Forefront's office, from the estimating skill's company.json (where the day's driving starts by default). */
function officeAddress(skillDir: string): string {
  try {
    return JSON.parse(readFileSync(path.join(skillDir, "assets", "company.json"), "utf8")).address ?? "";
  } catch {
    return "";
  }
}
