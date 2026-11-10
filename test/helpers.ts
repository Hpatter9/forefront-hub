import { MockTexts } from "../src/connectors/texts/index.js";
import { execFileSync } from "node:child_process";
import { copyFileSync, mkdtempSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { FixedApprover } from "../src/core/approval.js";
import { HUB_ROOT, loadConfig } from "../src/core/config.js";
import { MockCompanyCam } from "../src/connectors/companycam/index.js";
import { DocuSketch } from "../src/connectors/docusketch/index.js";
import { MockGmail } from "../src/connectors/gmail/mock.js";
import { MockCalendar } from "../src/connectors/calendar/index.js";
import { MockTasks } from "../src/connectors/tasks/index.js";
import { MockTravel } from "../src/connectors/travel/index.js";
import { MockHomebase } from "../src/connectors/homebase/mock.js";
import { EstimateSkill } from "../src/connectors/skill/index.js";
import { JobStore } from "../src/core/job.js";
import type { Hub } from "../src/hub.js";

/** The estimator repo, checked out next to this one (the skill's scripts are run for real in tests). */
export const ESTIMATOR_DIR = process.env.ESTIMATOR_DIR || path.resolve(HUB_ROOT, "..", "estimator");
export const PYTHON = process.env.PYTHON || (process.platform === "win32" ? "py" : "python3");

export function testHub(answer = true) {
  const root = mkdtempSync(path.join(os.tmpdir(), "hub-test-"));
  const cfg = loadConfig({ HUB_MODE: "mock", ESTIMATOR_DIR, PYTHON, DOWNLOADS_DIR: path.join(root, "Downloads") }, root);
  const gmail = new MockGmail(cfg.stateDir);
  const homebase = new MockHomebase();
  const approver = new FixedApprover(answer);
  const said: string[] = [];
  const hub: Hub = {
    cfg,
    jobs: new JobStore(cfg.jobsRoot),
    homebase,
    gmail,
    calendar: new MockCalendar(cfg.stateDir),
    tasks: new MockTasks(cfg.stateDir),
    travel: new MockTravel(),
    gemini: null,
    photos: new MockCompanyCam(),
    texts: new MockTexts([], false),
    sketches: new DocuSketch(gmail, cfg.docusketch.downloadsDir),
    skill: new EstimateSkill(cfg.skillDir, PYTHON),
    approver,
    say: (m) => said.push(m),
  };
  return { hub, gmail, homebase, approver, said, root };
}

/** Puts the sample estimate.json in the job's estimate/ folder and renders the three PDFs with the skill. */
export function renderSampleEstimate(hub: Hub, jobNumber: number) {
  const dir = hub.jobs.path(jobNumber, "estimate");
  const json = path.join(dir, "estimate.json");
  copyFileSync(path.join(HUB_ROOT, "fixtures", "estimate-sample.json"), json);
  execFileSync(PYTHON, [path.join(hub.cfg.skillDir, "scripts", "render.py"), json, "--out", dir]);
  return json;
}
