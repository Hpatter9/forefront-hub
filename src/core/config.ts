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
  model: string;
  homebase: { driver: "mock" | "browser" | "api"; url: string; apiToken: string; authFile: string; me: string };
  gmail: { driver: "mock" | "google"; clientId: string; clientSecret: string; address: string; tokenFile: string };
  companycam: { driver: "mock" | "rest"; token: string };
  docusketch: { downloadsDir: string };
  /** Where mocks keep their state (mock outbox, mock Homebase writes). */
  stateDir: string;
}

/** Reads .env from the hub folder (never committed) and fills in defaults. Mock wherever credentials are missing. */
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
    model: e("HUB_MODEL", "claude-opus-5-5"),
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
    docusketch: { downloadsDir: e("DOWNLOADS_DIR", path.join(env.USERPROFILE || env.HOME || root, "Downloads")) },
    stateDir,
  };
}
