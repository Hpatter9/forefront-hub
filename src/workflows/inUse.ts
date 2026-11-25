import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { hostname } from "node:os";
import path from "node:path";

/**
 * With Keystone's data in Google Drive, two PCs running Keystone at once would both write the same files. Each
 * running Keystone stamps keystone-in-use.json in the data folder every few minutes; one starting while another PC's
 * stamp is fresh says so. It only warns: the files are Hunter's, and a stamp can be left behind by a PC that crashed.
 */
const FRESH_MS = 12 * 60_000;
const file = (dir: string) => path.join(dir, "keystone-in-use.json");

export function otherPcUsing(dir: string, me = hostname(), now = Date.now()): { host: string; at: string } | null {
  try {
    if (!existsSync(file(dir))) return null;
    const s = JSON.parse(readFileSync(file(dir), "utf8")) as { host: string; at: string };
    return s.host && s.host !== me && now - Date.parse(s.at) < FRESH_MS ? s : null;
  } catch {
    return null;
  }
}

export function stampInUse(dir: string, me = hostname(), now = new Date()) {
  try {
    mkdirSync(dir, { recursive: true });
    writeFileSync(file(dir), JSON.stringify({ host: me, at: now.toISOString() }));
  } catch { /* a stamp is never worth failing over */ }
}
