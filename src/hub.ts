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

/** Everything a workflow or agent tool needs, in one place. Tests build one from mocks. */
export interface Hub {
  cfg: Config;
  jobs: JobStore;
  homebase: HomebaseClient;
  gmail: MailClient;
  calendar: CalendarClient;
  tasks: TasksClient;
  photos: PhotoClient;
  sketches: SketchSource;
  skill: EstimateSkill;
  approver: Approver;
  say: (msg: string) => void;
}

export function makeHub(cfg: Config = loadConfig(), approver: Approver = new CliApprover()): Hub {
  const gmail = makeGmail(cfg);
  return {
    cfg,
    jobs: new JobStore(cfg.jobsRoot),
    homebase: makeHomebase(cfg),
    gmail,
    calendar: makeCalendar(cfg),
    tasks: makeTasks(cfg),
    photos: makeCompanyCam(cfg),
    sketches: new DocuSketch(gmail, cfg.docusketch.downloadsDir),
    skill: new EstimateSkill(cfg.skillDir, cfg.python),
    approver,
    say: (m) => console.log(m),
  };
}

export function describe(hub: Hub): string[] {
  const c = hub.cfg;
  return [
    `mode        ${c.mode}`,
    `jobs        ${c.jobsRoot}`,
    `skill       ${c.skillDir}${hub.skill.check() ? `  (!) ${hub.skill.check()}` : ""}`,
    `python      ${c.python}`,
    `claude      ${c.anthropicApiKey ? `API key set (${c.model})` : "(!) no ANTHROPIC_API_KEY and no Estimator data/api_key.txt"}`,
    `homebase    ${hub.homebase.kind}${hub.homebase.kind === "browser" ? `  login: ${path.relative(c.hubRoot, c.homebase.authFile)}` : ""}`,
    `gmail       ${hub.gmail.kind}${hub.gmail.kind === "mock" ? `  (drafts go to ${path.join(c.stateDir, "outbox")})` : ` ${c.gmail.address}`}`,
    `companycam  ${hub.photos.kind}`,
    `calendar    ${hub.calendar.kind}${hub.calendar.kind === "google" && !hub.calendar.connected() ? "  (!) reconnect Google to add Calendar" : ""}`,
    `tasks       ${hub.tasks.kind}${hub.tasks.kind === "google" && !hub.tasks.connected() ? "  (!) reconnect Google to add Tasks" : ""}`,
    `docusketch  gmail delivery emails + ESX from ${c.docusketch.downloadsDir}`,
  ];
}
