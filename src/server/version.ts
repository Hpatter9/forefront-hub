import { execFile } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

/**
 * Which version of Keystone is running, and whether a newer one is waiting on GitHub, so Hunter can see at a
 * glance that updates are arriving (and restart into one with a click). The updating itself is
 * scripts/update.mjs, which runs before every start.
 */
export interface Version {
  hash: string;
  at: string;
  subject: string;
}
const git = (root: string, args: string[]) => new Promise<string>((resolve) => execFile("git", args, { cwd: root, timeout: 30_000, env: { ...process.env, GIT_TERMINAL_PROMPT: "0" } }, (err, out) => resolve(err ? "" : String(out).trim())));

let running: Version | null = null;
export async function runningVersion(root: string): Promise<Version | null> {
  if (running || !existsSync(path.join(root, ".git"))) return running;
  const [hash, at, ...subject] = (await git(root, ["log", "-1", "--format=%h|%cI|%s"])).split("|");
  if (hash) running = { hash, at: at ?? "", subject: subject.join("|") };
  return running;
}

let waiting = 0, checkedAt = 0;
/** How many changes are on GitHub that this copy doesn't have yet (checked at most every half hour). */
export async function updatesWaiting(root: string, force = false): Promise<number> {
  const mayUpdate = process.env.KEYSTONE_NO_UPDATE !== "1" && (process.platform === "win32" || process.env.KEYSTONE_UPDATE === "1");
  if (!mayUpdate || !existsSync(path.join(root, ".git"))) return 0;
  if (!force && Date.now() - checkedAt < 30 * 60_000) return waiting;
  checkedAt = Date.now();
  await git(root, ["fetch", "--quiet", "origin", process.env.KEYSTONE_BRANCH || "main"]);
  waiting = Number(await git(root, ["rev-list", "--count", "HEAD..FETCH_HEAD"])) || 0;
  return waiting;
}

/** What the updater did the last time Keystone started. */
export function lastUpdate(root: string): { at: string; ok: boolean; updated?: boolean; changes?: number; version?: string; note?: string; notes?: string[] } | null {
  try {
    return JSON.parse(readFileSync(path.join(root, ".hub", "update.json"), "utf8"));
  } catch {
    return null;
  }
}
