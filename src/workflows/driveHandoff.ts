import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { FOLDER, type DriveFile } from "../connectors/drive/index.js";
import type { Hub } from "../hub.js";
import { HANDOFF_ACTIONS, HANDOFF_DIR, handoffPackage, handoffPrompt, type HandoffAction } from "./claudeHandoff.js";

/**
 * Writing estimates in a Claude chat that can't see this PC (Claude Code on the web, on Hunter's subscription):
 * Google Drive is the hand-off. Keystone puts a job's package in "Keystone hand-off/<job# name>/for-claude" (the
 * same package as the Claude app hand-off, plus the request), Claude writes the estimate there and saves the PDFs
 * and estimate.json in ".../from-claude", and Keystone brings those into the job's estimate folder (asking first
 * when an estimate is already there; the old one is kept in estimate/revisions).
 *
 * The folder "Keystone hand-off" lives in Hunter's personal Drive (the account his Claude chats use) and is shared
 * with Keystone's Google account, so both sides see the same files.
 */
export const DRIVE_ROOT = "Keystone hand-off";
const FOR = "for-claude", FROM = "from-claude";
const RESULT_RX = /\.(pdf|json|md|txt|png|jpe?g|csv)$/i;
const WATCH_DAYS = 21;

interface Tracked { name: string; /** "local": the job folder itself is in Google Drive (synced), nothing is uploaded. */ mode?: "local"; folderId: string; forId: string; fromId: string; sentAt: string; pulled: Record<string, string>; declined?: Record<string, string> }
interface State { jobs: Record<string, Tracked> }
const stateFile = (hub: Hub) => path.join(hub.cfg.stateDir, "drive-handoff.json");
const load = (hub: Hub): State => { try { return { jobs: {}, ...JSON.parse(readFileSync(stateFile(hub), "utf8")) }; } catch { return { jobs: {} }; } };
const save = (hub: Hub, s: State) => { mkdirSync(hub.cfg.stateDir, { recursive: true }); writeFileSync(stateFile(hub), JSON.stringify(s, null, 1)); };

function drive(hub: Hub) {
  const d = hub.drive;
  if (!d) throw new Error("Google Drive isn't set up in this copy of Keystone.");
  if (!d.connected()) throw new Error("Keystone doesn't have Google Drive permission yet. Double-click Connect Gmail in the Keystone folder, sign in again and allow Google Drive, then restart Keystone.");
  return d;
}

/** Where the hand-off stands (for the page). */
export function driveHandoffStatus(hub: Hub, n: number) {
  const t = load(hub).jobs[n];
  return { connected: !!hub.drive?.connected(), sentAt: t?.sentAt ?? null, pulled: t ? Object.keys(t.pulled).length : 0 };
}

/**
 * True when the job folders already live in Google Drive (Move data to Google Drive): then the hand-off is the job
 * folder itself, kept in sync by Google Drive for desktop, and nothing has to be uploaded or downloaded.
 */
export const jobsInDrive = (hub: Hub) => /[\\/](My Drive|Shared drives)([\\/]|$)/i.test(hub.cfg.jobsRoot) || /^(on|1|yes|true)$/i.test(process.env.JOBS_IN_DRIVE ?? "");
/** "Keystone/Jobs/3212 Gorrell", as Drive shows it (after "My Drive"). */
export function driveLabel(file: string): string {
  const m = file.split(/[\\/]/);
  const i = m.findIndex((x) => /^(My Drive|Shared drives)$/i.test(x));
  return (i >= 0 ? m.slice(i + 1) : m.slice(-3)).join("/");
}
const requestText = (hub: Hub, n: number, action: HandoffAction, note: string, where: string) => {
  const job = hub.jobs.get(n);
  const { prompt } = handoffPrompt(hub, n, action, note);
  return [`# Request for job #${n} ${job.name}`, "", `Sent from Keystone ${new Date().toLocaleString("en-US", { timeZone: "America/Denver" })} (Denver time).`, "", `**What Hunter wants:** ${HANDOFF_ACTIONS[action]?.label ?? action}${note.trim() ? `\n\n**His note:** ${note.trim()}` : ""}`, "", `When you're done, put the PDFs and estimate.json in ${where}. Keystone brings them into the job.`, "", "## The request as Keystone words it", "", prompt].join("\n");
};

/** Puts the job's package and the request in Drive for Claude. */
export async function sendToDrive(hub: Hub, n: number, action: HandoffAction = "estimate", note = ""): Promise<{ folder: string; files: string[]; skipped: string[] }> {
  if (jobsInDrive(hub)) {
    // The job folder is already in Drive: the package goes in its for-claude folder and Claude answers in from-claude.
    const pkg = await handoffPackage(hub, n);
    const job = hub.jobs.get(n);
    const from = hub.jobs.path(n, FROM);
    mkdirSync(from, { recursive: true });
    writeFileSync(path.join(pkg.folder, "Request.md"), requestText(hub, n, action, note, `"${driveLabel(from)}" (the "${FROM}" folder next to this one)`));
    const s = load(hub);
    s.jobs[n] = { name: job.name, mode: "local", folderId: "", forId: "", fromId: "", sentAt: new Date().toISOString(), pulled: s.jobs[n]?.mode === "local" ? s.jobs[n].pulled : {}, declined: {} };
    save(hub, s);
    const local = readdirSync(pkg.folder).sort();
    hub.jobs.log(n, `Ready for Claude in Google Drive (${local.length} files in ${HANDOFF_DIR})`);
    hub.say(`#${n} ${job.name} is ready for Claude in Google Drive: "${driveLabel(pkg.folder)}" (${local.length} files; Google Drive uploads them in a minute or two). In your Claude chat, say what you want done on job ${n}.`);
    return { folder: driveLabel(pkg.folder), files: local, skipped: pkg.skipped };
  }
  const d = drive(hub);
  const root = await d.findFolder(DRIVE_ROOT);
  if (!root) throw new Error(`Keystone can't see the "${DRIVE_ROOT}" folder in Google Drive. It has to be shared with ${hub.cfg.gmail.address} (Claude sets this up from the chat; ask it to share the folder again).`);
  const pkg = await handoffPackage(hub, n);
  const job = hub.jobs.get(n);
  writeFileSync(path.join(pkg.folder, "Request.md"), requestText(hub, n, action, note, `this job's "${FROM}" folder in Drive`));
  const name = `${n} ${job.name}`.replace(/[\\/:*?"<>|]/g, " ").trim();
  const folder = await d.ensureFolder(name, root.id);
  const forF = await d.ensureFolder(FOR, folder.id), fromF = await d.ensureFolder(FROM, folder.id);
  const local = readdirSync(pkg.folder).sort();
  // The Drive folder mirrors the package: old files that aren't in it any more are removed (where Keystone may).
  for (const f of await d.list(forF.id)) if (f.mimeType !== FOLDER && !local.includes(f.name)) await d.remove(f.id).catch(() => {});
  for (const f of local) await d.upload(forF.id, path.join(pkg.folder, f));
  const s = load(hub);
  s.jobs[n] = { name: job.name, folderId: folder.id, forId: forF.id, fromId: fromF.id, sentAt: new Date().toISOString(), pulled: s.jobs[n]?.pulled ?? {}, declined: {} };
  save(hub, s);
  hub.jobs.log(n, `Sent to Claude through Google Drive (${local.length} files)`);
  hub.say(`#${n} ${job.name} is in Google Drive for Claude: "${DRIVE_ROOT} / ${name}" (${local.length} files). In your Claude chat, say what you want done on job ${n}.`);
  return { folder: `${DRIVE_ROOT}/${name}`, files: local, skipped: pkg.skipped };
}

const safe = (name: string) => path.basename(name).replace(/[<>:"/\\|?*\x00-\x1f]/g, "_");
const isEstimateDoc = (name: string) => /^estimate\.json$/i.test(name) || / - (Reconstruction Estimate|Reconstruction Agreement|Xactimate Estimate)\.pdf$/i.test(name);

/**
 * Brings what Claude left in Drive into the job's estimate folder. `n`: just that job (and ask again about files
 * Hunter said no to before); otherwise every job sent in the last few weeks. Returns what came in.
 */
export async function pullFromDrive(hub: Hub, n?: number): Promise<{ jobNumber: number; files: string[] }[]> {
  const s = load(hub);
  const needsApi = Object.entries(s.jobs).some(([k, t]) => t.mode !== "local" && (n === undefined || Number(k) === n));
  const d = needsApi ? drive(hub) : null;
  const out: { jobNumber: number; files: string[] }[] = [];
  const cutoff = Date.now() - WATCH_DAYS * 864e5;
  for (const [key, t] of Object.entries(s.jobs)) {
    const job = Number(key);
    if (n !== undefined ? job !== n : Date.parse(t.sentAt) < cutoff) continue;
    if (!hub.jobs.exists(job)) continue;
    let files: DriveFile[];
    // In the job folder itself (synced by Google Drive for desktop): the files in from-claude, by when they changed.
    const fromDir = hub.jobs.path(job, FROM);
    if (t.mode === "local") files = existsSync(fromDir) ? readdirSync(fromDir).filter((f) => RESULT_RX.test(f) && !f.startsWith(".")).map((f) => ({ id: f, name: f, mimeType: "", modifiedTime: statSync(path.join(fromDir, f)).mtime.toISOString() } as DriveFile)) : [];
    else {
      try { files = (await d!.list(t.fromId)).filter((f) => f.mimeType !== FOLDER && RESULT_RX.test(f.name)); }
      catch (e) { if (n !== undefined) throw e; continue; }
    }
    const fresh = files.filter((f) => t.pulled[f.id] !== f.modifiedTime && (n !== undefined || t.declined?.[f.id] !== f.modifiedTime));
    if (!fresh.length) continue;
    const dir = hub.jobs.path(job, "estimate");
    const replacing = existsSync(dir) && readdirSync(dir).some(isEstimateDoc) && fresh.some((f) => isEstimateDoc(f.name));
    if (replacing) {
      const ok = await hub.approver.confirm(`Claude finished #${job} ${t.name}. Bring it into the job?`, [...fresh.map((f) => f.name), "", "The estimate that's there now is kept in estimate/revisions."]);
      if (!ok) {
        t.declined = { ...(t.declined ?? {}), ...Object.fromEntries(fresh.map((f) => [f.id, f.modifiedTime])) };
        save(hub, s);
        hub.say(`Left Claude's files for #${job} in Google Drive. Press "Get what Claude made" on the job when you want them.`);
        continue;
      }
      const snap = hub.jobs.snapshotEstimate(job);
      if (snap) hub.say(`Saved the previous estimate to ${snap}`);
    }
    mkdirSync(dir, { recursive: true });
    const got: string[] = [];
    for (const f of fresh) {
      if (t.mode === "local") copyFileSync(path.join(fromDir, f.name), path.join(dir, safe(f.name)));
      else await d!.download(f.id, path.join(dir, safe(f.name)));
      t.pulled[f.id] = f.modifiedTime;
      got.push(safe(f.name));
    }
    save(hub, s);
    hub.jobs.log(job, `From Claude (Google Drive): ${got.join(", ")}`);
    hub.say(`#${job} ${t.name}: brought in from Claude: ${got.join(", ")}.`);
    out.push({ jobNumber: job, files: got });
  }
  return out;
}

export { HANDOFF_DIR };
