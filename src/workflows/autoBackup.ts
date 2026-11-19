import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { backupRoots, findBackup } from "../connectors/texts/index.js";
import type { Hub } from "../hub.js";

/**
 * Keeps the iPhone's backup (where Keystone reads texts from) fresh by itself: whenever the phone is plugged into
 * this PC and the backup is more than a few hours old, Keystone starts a backup (connectors/iphoneBackup). Checked
 * every few minutes; one backup at a time; after a failure it waits an hour before trying again and says why once.
 */
export const STALE_HOURS = 3;
const RETRY_MS = 60 * 60_000;
interface State { lastTryAt?: string; lastOkAt?: string; lastError?: string; setupFailedOn?: string }
const file = (hub: Hub) => path.join(hub.cfg.stateDir, "iphone-backup.json");
const load = (hub: Hub): State => { try { return JSON.parse(readFileSync(file(hub), "utf8")); } catch { return {}; } };
const save = (hub: Hub, s: State) => { mkdirSync(hub.cfg.stateDir, { recursive: true }); writeFileSync(file(hub), JSON.stringify(s, null, 1)); };

/** The folder holding one backup folder per phone: where this phone's backup already is, else Apple Devices' own. */
export function backupRootFor(hub: Hub, udid: string, env: NodeJS.ProcessEnv = process.env): string {
  const set = hub.cfg.texts.backupDir;
  if (set) return existsSync(path.join(set, "Manifest.db")) ? path.dirname(set) : set;
  // Apple names the folder after the phone's id (newer phones' ids have a dash that the folder name may drop).
  const names = [udid, udid.replace(/-/g, "")];
  const roots = backupRoots(env);
  for (const r of roots) if (names.some((n) => existsSync(path.join(r, n)))) return r;
  return roots.find((r) => existsSync(r)) ?? roots[0];
}

let running = false;
export type BackupResult = "off" | "fresh" | "no-phone" | "busy" | "waiting" | "setup-failed" | "failed" | "done";

export async function autoBackup(hub: Hub, o: { force?: boolean; now?: Date } = {}): Promise<BackupResult> {
  const tool = hub.phoneBackup;
  if (!tool || hub.texts.kind !== "iphone-backup") return "off";
  if (running) return "busy";
  const now = o.now ?? new Date();
  const s = load(hub);
  const newest = findBackup(hub.cfg.texts.backupDir || undefined);
  if (!o.force && newest && now.getTime() - newest.at.getTime() < STALE_HOURS * 3600e3) return "fresh";
  if (!o.force && s.lastError && s.lastTryAt && now.getTime() - Date.parse(s.lastTryAt) < RETRY_MS) return "waiting";
  const today = now.toISOString().slice(0, 10);
  if (!o.force && s.setupFailedOn === today) return "waiting";
  running = true;
  try {
    const problem = await tool.ready();
    if (problem) {
      if (s.setupFailedOn !== today) hub.say(`iPhone auto-backup isn't working yet: ${problem} Back Up Now in Apple Devices still works.`);
      save(hub, { ...s, setupFailedOn: today, lastError: problem, lastTryAt: now.toISOString() });
      return "setup-failed";
    }
    const phone = (await tool.devices())[0];
    if (!phone) return "no-phone";
    const root = backupRootFor(hub, phone.udid);
    hub.say(`${phone.name} is plugged in and its backup is ${newest ? "getting old" : "missing"}: backing it up now so your texts are current. If the phone asks for its passcode, type it. Leave it plugged in.`);
    try {
      await tool.backup(phone.udid, root);
    } catch (e) {
      const why = (e as Error).message;
      if (s.lastError !== why) hub.say(`The iPhone backup didn't finish (${why}). Keystone will try again in an hour; Back Up Now in Apple Devices still works.`);
      save(hub, { ...s, setupFailedOn: undefined, lastTryAt: now.toISOString(), lastError: why });
      return "failed";
    }
    save(hub, { lastTryAt: now.toISOString(), lastOkAt: new Date().toISOString() });
    hub.say("iPhone backed up. Texts are current.");
    return "done";
  } finally {
    running = false;
  }
}
