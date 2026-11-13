import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { pickProject } from "../connectors/companycam/index.js";
import type { Hub } from "../hub.js";
import { jobConversation } from "./conversation.js";
import { stockForJob, stockLine } from "./inventory.js";
import { conversationDigest, photoNotes, type ConversationDigest, type PhotoNotes } from "./jobDigest.js";
import { downloadPhotos, savedNotes } from "./pull.js";
import { jobWalks } from "./walks.js";

/**
 * Everything Keystone has on a job, gathered in one go, for the estimator to go through BEFORE it scopes or prices:
 * every file in the job folder, the photos (the folder's and CompanyCam's, whose previews are copied in if they
 * aren't yet), the emails and texts with the job's people, calls, walk recordings, the team's Homebase notes, and
 * shop stock that might fit. It also says plainly what's missing, so nothing is silently skipped.
 * This only collects; what it means for the scope is the estimating skill's business.
 */
export interface JobDossier {
  job: Record<string, unknown>;
  folder: string;
  /** Every file under the job folder, by subfolder (path relative to the job folder, size in KB). */
  files: Record<string, { path: string; kb: number }[]>;
  /** The DocuSketch files wherever they are (an .ESX, its PDFs, room images). There may be no .ESX. */
  docusketch: string[];
  photos: { inFolder: number; companycam: { linked: boolean; project?: string; total?: number; previews?: string; problem?: string }; howTo: string; /** Numbered contact sheets already made, and a line about each photo (by the free AI). */ sheets?: string[]; notes?: PhotoNotes["photos"] };
  notes: { jobNotes: string; teamNotes: { at: string; author: string; body: string }[]; walks: { file: string; at: string; summary: string }[] };
  /** Each email. `body` is left out when `conversation` (the digest) is there: read a whole thread with gmail_read_thread when a point matters. */
  emails: { at: string; who: string; subject: string; body?: string; attachments: string[]; threadId?: string }[];
  /** The emails, texts and calls boiled down ahead of time by the free AI: read this first. Absent when it wasn't made. */
  conversation?: ConversationDigest & { note: string };
  texts: { at: string; who: string; text: string }[];
  calls: { at: string; who: string; body: string }[];
  shopStock: string[];
  /** What couldn't be checked or isn't there, in plain words. Tell Hunter about these. */
  missing: string[];
}

const IMAGE = /\.(jpe?g|png|heic|webp|gif)$/i;

/**
 * A job's DocuSketch files, as paths relative to the job folder: anything in sketch/, plus files elsewhere that
 * DocuSketch names in its own way (its PDFs and "all images" zips and what was unpacked from them).
 */
export function sketchFiles(hub: Hub, n: number): string[] {
  const named = /docusketch|floor ?plan|measurement|sketch|all_images|_3d_|dollhouse/i;
  return [
    ...tree(hub.jobs.path(n, "sketch")).map((f) => `sketch/${f.path}`),
    ...tree(hub.jobs.path(n, "files")).filter((f) => named.test(f.path)).map((f) => `files/${f.path}`),
    ...tree(hub.jobs.path(n, "photos")).filter((f) => named.test(f.path) && !f.path.startsWith("previews/")).map((f) => `photos/${f.path}`),
    ...tree(hub.jobs.path(n, "email")).filter((f) => named.test(f.path)).map((f) => `email/${f.path}`),
  ];
}
function tree(dir: string, base = "", out: { path: string; kb: number }[] = []): { path: string; kb: number }[] {
  if (!existsSync(dir) || out.length >= 600) return out;
  for (const f of readdirSync(dir).sort()) {
    const full = path.join(dir, f), rel = base ? `${base}/${f}` : f;
    const s = statSync(full);
    if (s.isDirectory()) tree(full, rel, out);
    else if (out.length < 600) out.push({ path: rel, kb: Math.max(1, Math.round(s.size / 1024)) });
  }
  return out;
}

export async function jobDossier(hub: Hub, n: number): Promise<JobDossier> {
  const missing: string[] = [];
  let j = hub.jobs.get(n);

  // CompanyCam: link the project if it isn't, then copy the small previews in so they can be looked through.
  const cc: JobDossier["photos"]["companycam"] = { linked: !!j.companycamProjectId };
  try {
    if (!j.companycamProjectId) {
      const found = pickProject([...(await hub.photos.findProjects(String(n))), ...(await hub.photos.findProjects(j.address.split(",")[0]))], n, j.address);
      if (found) j = hub.jobs.upsert(n, { companycamProjectId: found.id });
    }
    if (j.companycamProjectId) {
      cc.linked = true;
      cc.project = j.companycamProjectId;
      const dir = path.join(hub.jobs.path(n, "photos"), "previews");
      const files = await downloadPhotos(hub, n, { size: "web", dir });
      cc.total = files.length;
      cc.previews = "photos/previews (index.json there has each photo's date and description)";
      if (!files.length) missing.push("The CompanyCam project has no photos yet.");
    } else missing.push("No CompanyCam project found for this job (searched by job number and street), so CompanyCam photos weren't checked.");
  } catch (e) {
    cc.problem = (e as Error).message;
    missing.push(`CompanyCam couldn't be read: ${cc.problem}`);
  }

  const files = Object.fromEntries((["sketch", "photos", "estimate", "files", "notes", "email"] as const).map((s) => [s, tree(hub.jobs.path(n, s))]));
  const inFolder = files.photos.filter((f) => IMAGE.test(f.path) && !f.path.startsWith("previews/")).length;
  const sketch = sketchFiles(hub, n);
  if (!sketch.length) missing.push("No DocuSketch files found: no .ESX, floor plan or measurement PDF, or room images.");
  else if (!sketch.some((f) => /\.esx$/i.test(f))) missing.push(`No DocuSketch .ESX (that's normal for some jobs): measurements come from the other DocuSketch files (${sketch.length}) and the walk transcript.`);
  if (!inFolder && !cc.total) missing.push("No photos at all: none in the job's photos folder and none from CompanyCam.");

  // Emails, texts, calls and walks with the job's people.
  let conv: Awaited<ReturnType<typeof jobConversation>>["items"] = [];
  try {
    conv = (await jobConversation(hub, n)).items;
  } catch (e) {
    missing.push(`The job's emails couldn't be read: ${(e as Error).message}`);
  }
  const emails = conv.filter((x) => x.kind === "email" && !x.draft).map((x) => ({ at: x.at, who: x.fromMe ? `Hunter ${x.who}` : x.who, subject: x.subject ?? "", body: x.body.slice(0, 1800), attachments: x.attachments ?? [], threadId: x.threadId }));
  const texts = conv.filter((x) => x.kind === "text").map((x) => ({ at: x.at, who: x.fromMe ? `Hunter ${x.who}` : x.who, text: x.body.slice(0, 600) }));
  const calls = conv.filter((x) => x.kind === "call").map((x) => ({ at: x.at, who: x.who, body: x.body.slice(0, 600) }));
  if (hub.gmail.kind !== "google" && hub.cfg.mode !== "mock") missing.push("Gmail isn't connected, so only emails already filed to the job were checked.");
  if (!emails.length) missing.push("No emails found for this job.");
  const tx = hub.texts.status();
  if (!tx.connected) missing.push("iPhone texts aren't connected, so texts weren't checked.");
  else if (!texts.length) missing.push("No texts with this job's contacts (as of the last iPhone backup).");

  // Reading done ahead by the free AI, so the paid one reads a digest instead of every message and photo.
  const [digest, pnotes] = await Promise.all([
    conversationDigest(hub, n, [...emails.slice(-50).map((e) => ({ kind: "email" as const, at: e.at, who: e.who, subject: e.subject, body: e.body, threadId: e.threadId })), ...texts.slice(-150).map((t) => ({ kind: "text" as const, at: t.at, who: t.who, body: t.text })), ...calls.slice(-30).map((c) => ({ kind: "call" as const, at: c.at, who: c.who, body: c.body }))].sort((a, b) => a.at.localeCompare(b.at))),
    photoNotes(hub, n),
  ]);

  const read = (f: string) => { try { return existsSync(f) ? readFileSync(f, "utf8") : ""; } catch { return ""; } };
  const walks = jobWalks(hub, n);
  const stock = stockForJob(hub, n);
  return {
    job: { jobNumber: n, name: j.name, address: j.address, stage: j.stage, market: j.market, customer: j.customer, occupant: j.occupant, adjuster: j.adjuster, carrier: j.carrier, claimNumber: j.claimNumber, insurance: j.insurance, estimate: j.estimate },
    folder: hub.jobs.folder(n),
    files,
    docusketch: sketch.slice(0, 200),
    photos: pnotes ? { inFolder, companycam: cc, sheets: pnotes.sheets, notes: pnotes.photos, howTo: "The photos are already on numbered contact sheets (`sheets`), with a line about each in `notes` written by a free assistant from those sheets. Use the notes to find the rooms in the scope, then look at the sheets that cover those rooms yourself before you scope them; you can skip sheets that only show rooms outside the scope. Open a full-size photo only when a sheet isn't clear enough. Don't run photo_sheets.py again." } : { inFolder, companycam: cc, howTo: "Look at every photo before scoping: run the skill's photo_sheets.py on photos/ (and photos/previews for CompanyCam) and read the contact sheets. Photos in subfolders of photos/ came from zips Hunter added." },
    notes: {
      jobNotes: read(hub.jobs.path(n, "notes", "notes.txt")).slice(0, 12_000),
      teamNotes: savedNotes(hub, n).flatMap((x) => [x, ...x.replies]).map((x) => ({ at: x.postedAt, author: x.author, body: x.body.slice(0, 1200) })).slice(0, 60),
      walks: walks.map((w) => ({ file: path.relative(hub.jobs.folder(n), w.file).split(path.sep).join("/"), at: w.at, summary: w.summary })),
    },
    ...(digest ? { conversation: { ...digest, note: "Made ahead of time by a free assistant from every email, text and call on the job. Work from these points; where a point decides scope, quantity or price, read the original (gmail_read_thread with the thread id in `source`) before relying on it." } } : {}),
    emails: digest ? emails.slice(-50).map(({ body: _body, ...e }) => e) : emails.slice(-50),
    texts: digest ? texts.slice(-30) : texts.slice(-150),
    calls: calls.slice(-30),
    shopStock: [...stock.named.map((x) => `Noted for this job: ${stockLine(x)}. ${x.notes}`), ...stock.kinds.flatMap((k) => k.items.map(stockLine))].slice(0, 40),
    missing,
  };
}
