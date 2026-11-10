import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { photoFileName, pickProject } from "../connectors/companycam/index.js";
import type { Contact, HbNote, JobDetail } from "../connectors/homebase/types.js";
import { noteJobContacts } from "./contacts.js";
import { lastName, type Job } from "../core/job.js";
import type { Hub } from "../hub.js";

/**
 * Homebase -> job.json, plus the CompanyCam project and DocuSketch sketch for the job. Safe to run any time:
 * it only fills in what Homebase knows and never clears what you've set by hand.
 */
/**
 * Who the customer is. Normally Homebase's primary contact. On a property-management (or HOA) job it's the
 * management company: the company's name, and its person and email (the one on the account, a Billing contact
 * first), or the account's billing email. A primary contact who isn't at the company (the owner or tenant) is kept
 * only as the occupant, for site access, and is never emailed as the customer.
 */
export function customerFor(hb: Pick<JobDetail, "contacts" | "account">): { customer?: Contact & { company?: string; attention?: string }; occupant?: Contact; managed: boolean } {
  const primary = hb.contacts.find((c) => c.role === "customer");
  const a = hb.account;
  if (!a?.propertyManager) return { customer: primary, managed: false };
  const atCompany = hb.contacts.filter((c) => c.role !== "adjuster" && ((a.id && c.accountId === a.id) || (!!c.company && c.company.toLowerCase() === a.name.toLowerCase())));
  const rank = (c: Contact) => (c.email ? 0 : 4) + ((c.roles ?? []).includes("Billing") ? 0 : 2) + (c.role === "customer" ? 0 : 1);
  const person = [...atCompany].sort((x, y) => rank(x) - rank(y))[0];
  const occupant = primary && !atCompany.includes(primary) ? primary : undefined;
  return {
    customer: { role: "customer", name: a.name, company: a.name, attention: person?.name ?? "", email: person?.email || a.billingEmail || "", phone: person?.phone || a.phone || "", id: person?.id },
    occupant,
    managed: true,
  };
}

export async function pullJob(hub: Hub, jobNumber: number, opts: { quiet?: boolean; lookups?: boolean } = {}): Promise<Job> {
  const say = opts.quiet ? () => {} : hub.say;
  const lookups = opts.lookups ?? true;
  const hb = await hub.homebase.getJob(jobNumber);
  const { customer, occupant, managed } = customerFor(hb);
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
    // A management company replaces whatever was there (an earlier pull may have saved the occupant as the customer);
    // its email is only kept from before when it was already the company's.
    customer: managed && customer
      ? { name: customer.name, company: customer.company ?? customer.name, attention: customer.attention || (prior?.customer.company === customer.name ? prior.customer.attention : "") || "", email: customer.email || (prior?.customer.company === customer.name ? prior.customer.email : "") || "", phone: customer.phone || (prior?.customer.company === customer.name ? prior.customer.phone : "") || "" }
      : customer
        ? { name: keep(customer.name, prior?.customer.name) ?? "", email: keep(customer.email, prior?.customer.email) ?? "", phone: keep(customer.phone, prior?.customer.phone) ?? "", company: "", attention: "" }
        : undefined,
    occupant: occupant ? { name: occupant.name, email: occupant.email, phone: occupant.phone, company: "", attention: "" } : managed ? null : prior?.occupant ?? null,
    adjuster: adjuster
      ? { name: keep(adjuster.name, prior?.adjuster.name) ?? "", email: keep(adjuster.email, prior?.adjuster.email) ?? "", phone: keep(adjuster.phone, prior?.adjuster.phone) ?? "" }
      : undefined,
    carrier: keep(hb.carrier, prior?.carrier) ?? "",
    claimNumber: keep(hb.claimNumber, prior?.claimNumber) ?? "",
    dateOfLoss: keep(hb.dateOfLoss, prior?.dateOfLoss) ?? "",
    companycamProjectId: prior?.companycamProjectId || hb.picturesLink?.match(/companycam\.com\/projects\/(\d+)/)?.[1] || undefined,
    insurance: prior?.insurance !== "unknown" && prior?.insurance ? prior.insurance : hb.claimNumber || adjuster ? "claim" : "unknown",
  });

  // Everyone on the job goes into the contacts list, with their role on it.
  noteJobContacts(hub, jobNumber, job.name, hb.contacts);

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
 * Photos stay in CompanyCam and Keystone shows them from there. This copies them down only when a file is needed:
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
