import { writeFileSync } from "node:fs";
import path from "node:path";
import { pickProject } from "../connectors/companycam/index.js";
import { lastName, type Job } from "../core/job.js";
import type { Hub } from "../hub.js";

/**
 * Homebase -> job.json, plus the CompanyCam project and DocuSketch sketch for the job. Safe to run any time:
 * it only fills in what Homebase knows and never clears what you've set by hand.
 */
export async function pullJob(hub: Hub, jobNumber: number): Promise<Job> {
  const hb = await hub.homebase.getJob(jobNumber);
  const customer = hb.contacts.find((c) => c.role === "customer");
  const adjuster = hb.contacts.find((c) => c.role === "adjuster");
  const prior = hub.jobs.exists(jobNumber) ? hub.jobs.get(jobNumber) : undefined;
  const keep = <T>(fresh: T | undefined | "", old: T | undefined) => (fresh === undefined || fresh === "" ? old : fresh);

  let job = hub.jobs.upsert(jobNumber, {
    name: prior?.name || lastName(customer?.name ?? "") || hb.name.split(/\s+/)[0] || "",
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
    insurance: prior?.insurance !== "unknown" && prior?.insurance ? prior.insurance : hb.claimNumber || adjuster ? "claim" : "unknown",
  });

  if (!job.companycamProjectId) {
    try {
      const street = job.address.split(",")[0];
      const found = [...(await hub.photos.findProjects(String(jobNumber))), ...(street ? await hub.photos.findProjects(street) : [])];
      const p = pickProject(found, jobNumber, job.address);
      if (p) {
        job = hub.jobs.upsert(jobNumber, { companycamProjectId: p.id });
        hub.say(`CompanyCam: ${p.name} (${p.photoCount} photos)`);
      } else hub.say("CompanyCam: no project found for this job yet");
    } catch (e) {
      hub.say(`CompanyCam: ${(e as Error).message}`);
    }
  }

  if (!job.docusketchProjectId) {
    try {
      const d = await hub.sketches.findDelivery({ name: job.name, address: job.address });
      if (d) {
        job = hub.jobs.upsert(jobNumber, { docusketchProjectId: d.projectId });
        hub.say(`DocuSketch: project ${d.projectId} (${d.projectName}) delivered ${d.deliveredAt}`);
      }
    } catch (e) {
      hub.say(`DocuSketch: ${(e as Error).message}`);
    }
  }
  if (job.docusketchProjectId) {
    const esx = await hub.sketches.fetchEsx({ projectId: job.docusketchProjectId, sketchDir: hub.jobs.path(jobNumber, "sketch") });
    hub.say(esx ? `Sketch: ${esx}` : `Sketch: download ${job.docusketchProjectId}*.ESX from https://app.docusketch.com/portal-cc/projects (it's picked up from Downloads)`);
  }

  hub.jobs.log(jobNumber, "Pulled from Homebase");
  return hub.jobs.get(jobNumber);
}

export async function downloadPhotos(hub: Hub, jobNumber: number): Promise<string[]> {
  const job = hub.jobs.get(jobNumber);
  if (!job.companycamProjectId) throw new Error(`No CompanyCam project linked to #${jobNumber}. Run: hub pull ${jobNumber}`);
  const photos = await hub.photos.listPhotos(job.companycamProjectId);
  const files = await hub.photos.download(photos, hub.jobs.path(jobNumber, "photos"));
  // Keep CompanyCam's dates and descriptions next to the files, for picking report photos later.
  const index = photos.map((p, i) => ({ file: path.basename(files[i]), id: p.id, capturedAt: p.capturedAt, description: p.description, creator: p.creator }));
  writeFileSync(hub.jobs.path(jobNumber, "photos", "index.json"), JSON.stringify(index, null, 2));
  hub.say(`${files.length} photos in ${hub.jobs.path(jobNumber, "photos")}`);
  return files;
}
