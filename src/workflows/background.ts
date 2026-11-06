import type { Hub } from "../hub.js";
import { syncFiles } from "./files.js";
import { pullJob } from "./pull.js";
import { pulse } from "./reminders.js";
import { sync } from "./sync.js";

export interface SyncAllResult {
  at: string;
  jobs: number;
  newFolders: number[];
  newFiles: { jobNumber: number; files: string[] }[];
  readyToLog: number[];
  needsUpload: { jobNumber: number; files: string[] }[];
  errors: { jobNumber: number; error: string }[];
}

const DAY = 864e5;

/**
 * Keeps a folder for each open reconstruction job up to date: Homebase facts into job.json, Homebase files into the
 * folder, and which send-off drafts have gone out. Read-only toward Homebase and Gmail; it never writes to either.
 * CompanyCam / DocuSketch look-ups for a job run at most once a day.
 */
export async function syncAll(hub: Hub, opts: { mine?: boolean; concurrency?: number } = {}): Promise<SyncAllResult> {
  const out: SyncAllResult = { at: new Date().toISOString(), jobs: 0, newFolders: [], newFiles: [], readyToLog: [], needsUpload: [], errors: [] };
  // Hunter is the only estimator, so every open recon job is his (pass mine: true to narrow it).
  const jobs = await hub.homebase.listJobs({ openOnly: true, mine: opts.mine ? hub.cfg.homebase.me : undefined });
  const wanted = new Set(jobs.map((j) => j.jobNumber));
  // Also keep any job you set up by hand, even if it isn't "mine" in Homebase.
  for (const j of hub.jobs.list()) wanted.add(j.jobNumber);
  out.jobs = wanted.size;

  const queue = [...wanted];
  const worker = async () => {
    for (let n = queue.shift(); n !== undefined; n = queue.shift()) {
      try {
        const fresh = !hub.jobs.exists(n);
        const prior = fresh ? undefined : hub.jobs.get(n);
        const lookups = fresh || !prior!.lookupsAt || Date.now() - Date.parse(prior!.lookupsAt) > DAY;
        await pullJob(hub, n, { quiet: true, lookups });
        if (fresh) out.newFolders.push(n);
        const f = await syncFiles(hub, n);
        if (f.downloaded.length) out.newFiles.push({ jobNumber: n, files: f.downloaded });
        if (f.toUpload.length) out.needsUpload.push({ jobNumber: n, files: f.toUpload.map((x) => x.name) });
        const s = await sync(hub, n, { checkOnly: true });
        if (s.some((r) => r.note?.startsWith("sent; ready"))) out.readyToLog.push(n);
        const pl = await pulse(hub, hub.jobs.get(n));
        hub.jobs.upsert(n, { syncedAt: new Date().toISOString(), pulse: pl });
        // Homebase didn't name an adjuster but the emails make it clear: keep it in the job folder (not Homebase).
        const jj = hub.jobs.get(n);
        if (pl.adjusterGuess && !jj.adjuster.email) {
          hub.jobs.upsert(n, { adjuster: { name: pl.adjusterGuess.name, email: pl.adjusterGuess.email, phone: jj.adjuster.phone }, insurance: jj.insurance === "unknown" ? "claim" : jj.insurance });
          hub.jobs.log(n, `Adjuster from the job's emails: ${pl.adjusterGuess.name || pl.adjusterGuess.email} <${pl.adjusterGuess.email}> (${pl.adjusterGuess.why})`);
        }
      } catch (e) {
        out.errors.push({ jobNumber: n, error: (e as Error).message });
      }
    }
  };
  await Promise.all(Array.from({ length: opts.concurrency ?? 3 }, worker));
  return out;
}
