import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import dotenv from "dotenv";

export const HUB_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

export type Mode = "mock" | "live";

export interface Config {
  hubRoot: string;
  /** This computer's own folder (.hub in Keystone): Python tools, the update record. Never in Google Drive. */
  localDir: string;
  mode: Mode;
  estimatorDir: string;
  skillDir: string;
  jobsRoot: string;
  python: string;
  anthropicApiKey: string;
  /** An Anthropic Admin key (sk-ant-admin...), only for reading the account's spending. */
  anthropicAdminKey: string;
  /**
   * Which AI runs Keystone's AI features. HUB_AI=gemini | claude | off; when it isn't set: Gemini if there's a
   * GEMINI_API_KEY, else Claude if there's an Anthropic key, else off. The Estimator tab and setting up
   * selections use the Claude-only estimating skill, so they need Claude.
   */
  ai: { provider: "claude" | "gemini" | "off"; /** The one Gemini key: the free one. */ geminiKey: string; /** Not a key marked free (GEMINI_FREE_API_KEY): shown in the status line. */ geminiKeyNotMarkedFree?: boolean; /** Names a caller passes; FreeGemini picks the actual model (best free one answering). A "lite" name means a quick job. */ geminiModel: string; geminiFastModel: string; geminiFallbacks?: string[] };
  model: string;
  /** A fast, cheaper model for small jobs like one-line email summaries. */
  fastModel: string;
  homebase: { driver: "mock" | "browser" | "api"; url: string; apiToken: string; authFile: string; me: string; /** The job field for the Proposal Submitted update line (blank: found by name). */ updateField?: string };
  gmail: { driver: "mock" | "google"; clientId: string; clientSecret: string; address: string; tokenFile: string };
  companycam: { driver: "mock" | "rest"; token: string };
  docusketch: { downloadsDir: string };
  /** Walk recordings: the folder on this PC they arrive in (from the phone, via Google Drive), and when it was set up. */
  walks: { dir: string; since: string };
  /** iPhone texts, read from the phone's backup on this PC (off until Connect iPhone texts turns it on). */
  /** The hand-off email drafted when a homeowner signs: who takes the job over (HANDOFF_EMAIL=off turns it off). */
  handoff: { on: boolean; pmName: string; pmEmail: string };
  texts: { enabled: boolean; backupDir: string; /** The iPhone backup password, when the backup is encrypted. */ password: string; /** Start a backup when the phone is plugged in and the backup is old. */ autoBackup: boolean };
  spotify: { clientId: string };
  /** Drive times for calendar events: where the day's driving starts. */
  travel: { start: string };
  /** Where mocks keep their state (mock outbox, mock Homebase writes). */
  stateDir: string;
}

/** Google's free-tier models, in the order everyday work tries them. */
export const FREE_GEMINI = ["gemini-3.5-flash", "gemini-flash-latest", "gemini-flash-lite-latest"];
/** A Flash model (free tier), not a paid or preview heavyweight. */
export const isFreeGemini = (m: string) => /flash/i.test(m) && !/pro|ultra|hydrogen|argon|image|tts|live/i.test(m);

/** Reads .env from the Keystone folder (never committed) and fills in defaults. Mock wherever credentials are missing. */
export function loadConfig(env: NodeJS.ProcessEnv = process.env, root = HUB_ROOT): Config {
  if (env === process.env) dotenv.config({ path: path.join(root, ".env"), quiet: true } as dotenv.DotenvConfigOptions);
  const e = (k: string, d = "") => (env[k] ?? "").trim() || d;
  const mode: Mode = e("HUB_MODE", "live") === "mock" ? "mock" : "live";
  const live = mode === "live";
  const isWin = process.platform === "win32";

  const estimatorDir = e("ESTIMATOR_DIR", isWin ? "C:\\Games\\Estimator" : path.join(root, "..", "estimator"));
  const skillDir = e("SKILL_DIR", path.join(estimatorDir, "skill", "forefront-estimate"));
  // Keystone's own data (contacts, drafts made, caches, the game...). HUB_DATA_DIR puts it in a Google Drive folder
  // (Move data to Google Drive); things that only make sense on this computer stay in localDir.
  const localDir = path.join(root, ".hub");
  const stateDir = e("HUB_DATA_DIR", localDir);

  // Claude's key, in this order: Keystone's own .env, the Estimator app's saved key, then a key set on the PC.
  // Only real Anthropic keys (sk-ant-...) count: add-ons that send Claude to ChatGPT set fake ones on the PC.
  const keyFile = path.join(estimatorDir, "data", "api_key.txt");
  const fromDotEnv = (() => {
    try {
      const f = path.join(root, ".env");
      return env === process.env && existsSync(f) ? (dotenv.parse(readFileSync(f)).ANTHROPIC_API_KEY ?? "").trim() : "";
    } catch {
      return "";
    }
  })();
  const candidates = env === process.env ? [fromDotEnv, existsSync(keyFile) ? readFileSync(keyFile, "utf8").trim() : "", (process.env.ANTHROPIC_API_KEY ?? "").trim()] : [e("ANTHROPIC_API_KEY")];
  const anthropicApiKey = candidates.find((k) => k && (env !== process.env || k.startsWith("sk-ant-"))) ?? "";

  const hbDriver = e("HOMEBASE_DRIVER", e("HOMEBASE_API_TOKEN") ? "api" : "browser") as Config["homebase"]["driver"];
  const gmailReady = !!(e("GOOGLE_CLIENT_ID") && e("GOOGLE_CLIENT_SECRET"));
  const ccToken = e("COMPANYCAM_TOKEN");

  return {
    hubRoot: root,
    localDir,
    mode,
    estimatorDir,
    skillDir,
    jobsRoot: e("JOBS_ROOT", live ? (isWin ? "C:\\Jobs" : path.join(root, "jobs")) : path.join(stateDir, "jobs")),
    python: e("PYTHON", isWin ? "py" : "python3"),
    anthropicApiKey,
    anthropicAdminKey: e("ANTHROPIC_ADMIN_KEY"),
    ai: (() => {
      // Gemini runs on one key, the free one (GEMINI_FREE_API_KEY, saved by Connect Gemini). Keystone then picks
      // the best model that key answers on and steps down when one is over its free limit (FreeGemini). A key under
      // the old name GEMINI_API_KEY is used only when there's no free one.
      const free = e("GEMINI_FREE_API_KEY");
      const geminiKey = free || e("GEMINI_API_KEY", e("GOOGLE_API_KEY"));
      const want = e("HUB_AI").toLowerCase();
      const provider: Config["ai"]["provider"] =
        want === "off" ? "off" : want === "gemini" ? (geminiKey ? "gemini" : "off") : want === "claude" ? (anthropicApiKey ? "claude" : "off") : geminiKey ? "gemini" : "off";
      // Everyday features (summaries, tasks, brief, Ask, email wording) never fall back to the paid Claude API on
      // their own: only the estimating skill uses Claude. HUB_AI=claude is a deliberate opt-in.
      return {
        provider,
        geminiKey,
        geminiKeyNotMarkedFree: !!geminiKey && !free,
        geminiModel: FREE_GEMINI[0],
        geminiFastModel: "gemini-flash-lite-latest",
        geminiFallbacks: FREE_GEMINI,
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
      updateField: e("HOMEBASE_UPDATE_FIELD"),
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
    handoff: { on: !/^(off|0|false|no)$/i.test(e("HANDOFF_EMAIL")), pmName: e("HANDOFF_PM_NAME", "Shannon Hoag"), pmEmail: e("HANDOFF_PM_EMAIL", "shannon@forefrontteam.com") },
    texts: { enabled: /^(on|1|true|yes)$/i.test(e("IPHONE_TEXTS")), autoBackup: !/^(off|0|false|no)$/i.test(e("IPHONE_AUTO_BACKUP")), backupDir: e("IPHONE_BACKUP_DIR"), password: e("IPHONE_BACKUP_PASSWORD_B64") ? Buffer.from(e("IPHONE_BACKUP_PASSWORD_B64"), "base64").toString("utf8") : e("IPHONE_BACKUP_PASSWORD") },
    walks: { dir: e("WALK_RECORDINGS_DIR"), since: e("WALK_RECORDINGS_SINCE") },
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
