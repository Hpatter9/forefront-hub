import { makeDrive, type DriveClient } from "./connectors/drive/index.js";
import { makePhoneBackup, type PhoneBackup } from "./connectors/iphoneBackup/index.js";
import { makeClaudeCost, type ClaudeCost } from "./connectors/anthropicCost/index.js";
import { FreeGemini, makeGemini, type GeminiClient } from "./connectors/gemini/index.js";
import { makeTravel, type TravelClient } from "./connectors/travel/index.js";
import path from "node:path";
import { CliApprover, type Approver } from "./core/approval.js";
import { loadConfig, type Config } from "./core/config.js";
import { JobStore } from "./core/job.js";
import { makeCompanyCam, type PhotoClient } from "./connectors/companycam/index.js";
import { DocuSketch, type SketchSource } from "./connectors/docusketch/index.js";
import { makeGmail, type MailClient } from "./connectors/gmail/index.js";
import { makeCalendar, type CalendarClient } from "./connectors/calendar/index.js";
import { makeTasks, type TasksClient } from "./connectors/tasks/index.js";
import { makeHomebase, type HomebaseClient } from "./connectors/homebase/index.js";
import { EstimateSkill } from "./connectors/skill/index.js";
import { makeTexts, type TextsClient } from "./connectors/texts/index.js";

/** Everything a workflow or agent tool needs, in one place. Tests build one from mocks. */
export interface Hub {
  cfg: Config;
  jobs: JobStore;
  homebase: HomebaseClient;
  gmail: MailClient;
  calendar: CalendarClient;
  tasks: TasksClient;
  travel: TravelClient;
  /** Gemini, when it's Keystone's AI (null otherwise). */
  gemini: GeminiClient | null;
  /** Anthropic's own count of this month's spending, when an Admin key is set (null otherwise). */
  claudeCost?: ClaudeCost | null;
  photos: PhotoClient;
  /** Text messages from the iPhone's backup (off unless turned on). */
  texts: TextsClient;
  /** Google Drive: only the hand-off folder for writing estimates in a Claude chat. */
  drive?: DriveClient;
  /** Starts iPhone backups itself when the phone is plugged in (null when off). */
  phoneBackup?: PhoneBackup | null;
  sketches: SketchSource;
  skill: EstimateSkill;
  approver: Approver;
  say: (msg: string) => void;
}

export function makeHub(cfg: Config = loadConfig(), approver: Approver = new CliApprover()): Hub {
  const gmail = makeGmail(cfg);
  const hub: Hub = {
    cfg,
    jobs: new JobStore(cfg.jobsRoot),
    homebase: makeHomebase(cfg),
    gmail,
    calendar: makeCalendar(cfg),
    tasks: makeTasks(cfg),
    travel: makeTravel(cfg),
    gemini: makeGemini(cfg),
    claudeCost: makeClaudeCost(cfg.anthropicAdminKey),
    photos: makeCompanyCam(cfg),
    texts: makeTexts(cfg),
    drive: makeDrive(cfg),
    phoneBackup: makePhoneBackup(cfg),
    sketches: new DocuSketch(gmail, cfg.docusketch.downloadsDir),
    skill: new EstimateSkill(cfg.skillDir, cfg.python),
    approver,
    say: (m) => console.log(m),
  };
  return hub;
}

export function describe(hub: Hub): string[] {
  const c = hub.cfg;
  return [
    `mode        ${c.mode}`,
    `jobs        ${c.jobsRoot}`,
    `skill       ${c.skillDir}${hub.skill.check() ? `  (!) ${hub.skill.check()}` : ""}`,
    `python      ${c.python}`,
    `ai          ${c.ai.provider === "gemini" ? `Gemini, free key, best model it answers on${hub.gemini instanceof FreeGemini && hub.gemini.lastModel ? ` (now ${hub.gemini.lastModel})` : ""}${c.ai.geminiKeyNotMarkedFree ? "  (!) the key is saved as GEMINI_API_KEY: if its Google project has billing on, run Connect Gemini to save your free key" : ""}` : c.ai.provider === "claude" ? `Claude (${c.model})` : "off"}`,
    `homebase    ${hub.homebase.kind}${hub.homebase.kind === "browser" ? `  login: ${path.relative(c.hubRoot, c.homebase.authFile)}` : ""}`,
    `gmail       ${hub.gmail.kind}${hub.gmail.kind === "mock" ? `  (drafts go to ${path.join(c.stateDir, "outbox")})` : ` ${c.gmail.address}`}`,
    `companycam  ${hub.photos.kind}`,
    `calendar    ${hub.calendar.kind}${hub.calendar.kind === "google" && !hub.calendar.connected() ? "  (!) reconnect Google to add Calendar" : ""}`,
    `tasks       ${hub.tasks.kind}${hub.tasks.kind === "google" && !hub.tasks.connected() ? "  (!) reconnect Google to add Tasks" : ""}`,
    `texts       ${hub.texts.kind === "off" ? "off (Connect iPhone texts turns it on)" : hub.texts.status().connected ? `iPhone backup from ${hub.texts.status().backupAt?.slice(0, 16).replace("T", " ")}` : `(!) ${hub.texts.status().problem}`}`,
    `docusketch  gmail delivery emails; floor plans from ${c.docusketch.downloadsDir}`,
  ];
}
