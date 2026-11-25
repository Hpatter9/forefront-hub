import { cpSync, existsSync, readdirSync, statSync } from "node:fs";
import { hostname } from "node:os";
import path from "node:path";
import { createInterface } from "node:readline/promises";
import { loadConfig } from "../core/config.js";
import { setEnv } from "./connect.js";

/**
 * Move data to Google Drive: puts the job folders and Keystone's own data in a Google Drive folder that Google Drive
 * for desktop keeps in sync, so they're in the cloud (and on any PC signed into the same Drive). The keys and logins
 * (.env, auth/) and this computer's Python tools stay on the laptop. Nothing is deleted: the old folders stay where
 * they are as a backup, and Keystone simply starts using the Drive copies (JOBS_ROOT and HUB_DATA_DIR in .env).
 */

/** What isn't copied into Drive: tools built for this computer, and the record of this computer's updates. */
const LOCAL_ONLY = new Set(["iphone-tools", "update.json", "keystone-in-use.json"]);

/** The "My Drive" folders Google Drive for desktop shows (one drive letter per Google account), plus shared drives. */
export function driveFolders(letters = "DEFGHIJKLMNOPQRSTUVWXYZ"): string[] {
  const out: string[] = [];
  for (const l of letters) {
    for (const name of ["My Drive", "Shared drives"]) {
      const p = `${l}:\\${name}`;
      try { if (existsSync(p) && statSync(p).isDirectory()) out.push(p); } catch { /* not there */ }
    }
  }
  return out;
}

const isEmpty = (dir: string) => !existsSync(dir) || readdirSync(dir).filter((f) => !f.startsWith(".")).length === 0;

async function ask(q: string): Promise<string> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try { return (await rl.question(q)).trim(); } finally { rl.close(); }
}

/** Copies `from` into `to`, never replacing a file that's already there (a second PC adding to the same Drive). */
export function copyInto(from: string, to: string, skip: Set<string> = new Set()): number {
  let n = 0;
  if (!existsSync(from)) return 0;
  cpSync(from, to, {
    recursive: true,
    force: false,
    errorOnExist: false,
    filter: (src) => {
      const rel = path.relative(from, src);
      const top = rel.split(path.sep)[0];
      if (skip.has(top)) return false;
      try { if (statSync(src).isFile()) n++; } catch { /* gone */ }
      return true;
    },
  });
  return n;
}

async function keystoneRunning(): Promise<boolean> {
  try { await fetch("http://127.0.0.1:4317/api/status", { signal: AbortSignal.timeout(1500) }); return true; } catch { return false; }
}

export async function moveToDrive(given?: string) {
  const cfg = loadConfig();
  console.log("Moving Keystone's job folders and data into Google Drive.\n");
  if (await keystoneRunning()) throw new Error("Keystone is open. Close its black window first, then run Move data to Google Drive again.");

  let base = given?.trim() || "";
  if (!base) {
    const found = driveFolders();
    if (!found.length) {
      console.log("Google Drive for desktop isn't on this PC yet (no \"My Drive\" folder found).");
      console.log("1. Install it from https://www.google.com/drive/download/ and sign in with your WORK account");
      console.log("   (hunter@forefrontteam.com): customer files belong in Forefront's Drive.");
      console.log("2. Wait until it shows a Google Drive folder in File Explorer, then run Move data to Google Drive again.");
      return;
    }
    console.log("Google Drive folders on this PC (File Explorer shows which Google account each letter is):");
    found.forEach((f, i) => console.log(`  ${i + 1}. ${f}`));
    const pick = found.length === 1 ? "1" : await ask(`\nWhich one is your work account's Drive? Type the number and press Enter: `);
    base = found[Number(pick) - 1] ?? "";
    if (!base) throw new Error("No folder picked; nothing was changed.");
  }
  const root = path.join(base, "Keystone");
  const jobs = path.join(root, "Jobs"), data = path.join(root, "Data");
  const already = !isEmpty(jobs) || !isEmpty(data);
  console.log(`\nKeystone will keep:\n  job folders in   ${jobs}\n  its own data in  ${data}`);
  console.log("Your keys and logins (.env, auth) and this PC's tools stay on this computer, as now.");
  if (already) console.log("\nThat Google Drive folder already has Keystone data (from another PC?). Files there are kept; only files it doesn't have are added from this PC.");
  if (!/^y/i.test(await ask("\nGo ahead? Type Y and press Enter: "))) return console.log("Nothing was changed.");

  const fromJobs = cfg.jobsRoot, fromData = cfg.stateDir;
  const sameJobs = path.resolve(fromJobs) === path.resolve(jobs), sameData = path.resolve(fromData) === path.resolve(data);
  console.log("\nCopying (Google Drive uploads in the background; big job folders can take a while to finish uploading)...");
  const nJobs = sameJobs ? 0 : copyInto(fromJobs, jobs);
  const nData = sameData ? 0 : copyInto(fromData, data, LOCAL_ONLY);
  setEnv({ JOBS_ROOT: jobs, HUB_DATA_DIR: data });
  console.log(`\nDone: ${nJobs} job files and ${nData} data files copied. Keystone now uses the Google Drive folders.`);
  console.log(`The old copies are still in ${fromJobs} and ${fromData} as a backup; delete them yourself once you're happy.`);
  console.log("Open Keystone as usual. Only run Keystone on one PC at a time: two at once would both write the same files.");
  console.log(`(This PC: ${hostname()}.)`);
}
