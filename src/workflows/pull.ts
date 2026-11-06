import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { photoFileName, pickProject } from "../connectors/companycam/index.js";
import type { HbNote } from "../connectors/homebase/types.js";
import { lastName, type Job } from "../core/job.js";
import type { Hub } from "../hub.js";

/**
 * Homebase -> job.json, plus the CompanyCam project and DocuSketch sketch for the job. Safe to run any time:
 * it only fills in what Homebase knows and never clears what you've set by hand.
 */
export async function pullJob(hub: Hub, jobNumber: number, opts: { quiet?: boolean; lookups?: boolean } = {}): Promise<Job> {
  const say = opts.quiet ? () => {} : hub.say;
  const lookups = opts.lookups ?? true;
  const hb = await hub.homebase.getJob(jobNumber);
  const customer = hb.contacts.find((c) => c.role === "customer");
  const adjuster = hb.contacts.find((c) => c.role === "adjuster");
  const prior = hub.jobs.exists(jobNumber) ? hub.jobs.get(jobNumber) : undefined;
  const keep = <T>(fresh: T | undefined | "", old: T | undefined) => (fresh === undefined || fresh === "" ? old : fresh);

  let job = hub.jobs.upsert(jobNumber, {
    // Homebase's own short customer name ("Augustine", "Westward 360"), else the main contact's last name.
    name: hb.name || prior?.name || lastName(customer?.name ?? "") || "",
    homebaseId: hb.id,
    homebaseUrl: hb.url,
    address: keep(hb.address, prior?.address) ?? "",
    stage: hb.stage,
    stageSince: hb.stageSince ?? prior?.stageSince ?? "",
    customer: customer
      ? { name: keep(customer.name, prior?.customer.name) ?? "", email: keep(customer.email, prior?.customer.email) ?? "", phone: keep(customer.phone, prior?.customer.phone) ?? "" }
      : undefined,
    adjuster: adjuster
      ? { name: keep(adjuster.name, prior?.adjuster.name) ?? "", email: keep(adjuster.email, prior?.adjuster.email) ?? "", phone: keep(adjuster.phone, prior?.adjuster.phone) ?? "" }
      : undefined,
    carrier: keep(hb.carrier, prior?.carrier) ?? "",
    claimNumber: keep(hb.claimNumber, prior?.claimNumber) ?? "",
    dateOfLoss: keep(hb.dateOfLoss, prior?.dateOfLoss) ?? "",
    companycamProjectId: prior?.companycamProjectId || hb.picturesLink?.match(/companycam\.com\/projects\/(\d+)/)?.[1] || undefined,
    insurance: prior?.insurance !== "unknown" && prior?.insurance ? prior.insurance : hb.claimNumber || adjuster ? "claim" : "unknown",
  });

  // The Notes tab (Forefront's internal conversation), kept in the folder for the dashboard's team-notes card.
  if (hb.noteFeed) saveNotes(hub, jobNumber, hb.noteFeed);

  if (lookups && !job.companycamProjectId) {
    try {
      const street = job.address.split(",")[0];
      const found = [...(await hub.photos.findProjects(String(jobNumber))), ...(street ? await hub.photos.findProjects(street) : [])];
      const p = pickProject(found, jobNumber, job.address);
      if (p) {
        job = hub.jobs.upsert(jobNumber, { companycamProjectId: p.id });
        say(`CompanyCam: ${p.name} (${p.photoCount} photos)`);
      } else say("CompanyCam: no project found for this job yet");
    } catch (e) {
      say(`CompanyCam: ${(e as Error).message}`);
    }
  }

  if (lookups && !job.docusketchProjectId) {
    try {
      const d = await hub.sketches.findDelivery({ name: job.name, address: job.address });
      if (d) {
        job = hub.jobs.upsert(jobNumber, { docusketchProjectId: d.projectId });
        say(`DocuSketch: project ${d.projectId} (${d.projectName}) delivered ${d.deliveredAt}`);
      }
    } catch (e) {
      say(`DocuSketch: ${(e as Error).message}`);
    }
  }
  if (job.docusketchProjectId) {
    const esx = await hub.sketches.fetchEsx({ projectId: job.docusketchProjectId, sketchDir: hub.jobs.path(jobNumber, "sketch") });
    say(esx ? `Sketch: ${esx}` : `Sketch: download ${job.docusketchProjectId}*.ESX from https://app.docusketch.com/portal-cc/projects (it's picked up from Downloads)`);
  }

  if (lookups) hub.jobs.upsert(jobNumber, { lookupsAt: new Date().toISOString() });
  if (!opts.quiet) hub.jobs.log(jobNumber, "Pulled from Homebase");
  return hub.jobs.get(jobNumber);
}

/**
 * Photos stay in CompanyCam and the hub shows them from there. This copies them down only when a file is needed:
 * small previews for Claude to pick report photos from, and full size for the photos that go in a report.
 * `only`: just these file names (cc_<date>_<id>.jpg). Writes index.json (dates, descriptions) next to them.
 */
export async function downloadPhotos(hub: Hub, jobNumber: number, o: { size?: "original" | "web"; dir?: string; only?: string[] } = {}): Promise<string[]> {
  const job = hub.jobs.get(jobNumber);
  if (!job.companycamProjectId) throw new Error(`No CompanyCam project linked to #${jobNumber}. Run: hub pull ${jobNumber}`);
  const dir = o.dir ?? hub.jobs.path(jobNumber, "photos");
  let photos = await hub.photos.listPhotos(job.companycamProjectId);
  if (o.only) photos = photos.filter((p) => o.only!.includes(photoFileName(p)));
  const files = await hub.photos.download(photos, dir, o.size ?? "original");
  const index = photos.map((p, i) => ({ file: path.basename(files[i]), id: p.id, capturedAt: p.capturedAt, description: p.description, creator: p.creator }));
  writeFileSync(path.join(dir, "index.json"), JSON.stringify(index, null, 2));
  hub.say(`${files.length} photo${files.length === 1 ? "" : "s"} copied from CompanyCam${o.size === "web" ? " (previews)" : ""}`);
  return files;
}

/** Keeps the job's Homebase Notes tab in notes/homebase-notes.json. */
export function saveNotes(hub: Hub, jobNumber: number, feed: HbNote[]) {
  const f = hub.jobs.path(jobNumber, "notes", "homebase-notes.json");
  mkdirSync(path.dirname(f), { recursive: true });
  writeFileSync(f, JSON.stringify({ at: new Date().toISOString(), notes: feed }, null, 2));
}

export function savedNotes(hub: Hub, jobNumber: number): HbNote[] {
  const f = hub.jobs.path(jobNumber, "notes", "homebase-notes.json");
  try {
    return existsSync(f) ? JSON.parse(readFileSync(f, "utf8")).notes ?? [] : [];
  } catch {
    return [];
  }
}
