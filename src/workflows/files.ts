import { createHash } from "node:crypto";
import { copyFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { DocumentKind, HomebaseDocument } from "../connectors/homebase/types.js";
import type { Hub } from "../hub.js";

/**
 * Two-way file sync between a job folder and the job's Documents tab in Homebase.
 *
 * Homebase -> hub (automatic, read-only): every document is mirrored into <job>/homebase/ (homebase/index.json maps
 * Homebase ids to files). The standard estimate files ("<Last> - Reconstruction Estimate.pdf" and friends) are also
 * copied into estimate/ when Keystone has none of that name, so a send-off can use them. A file already in estimate/
 * is never overwritten from Homebase: Keystone's copy wins.
 *
 * Hub -> Homebase (asks first): the standard estimate files in estimate/ whose content Homebase doesn't have yet
 * (compared by SHA-256) are offered for upload.
 */
export const STANDARD_FILES: { suffix: string; kind: DocumentKind }[] = [
  { suffix: " - Reconstruction Estimate.pdf", kind: "estimate" },
  { suffix: " - Reconstruction Agreement.pdf", kind: "contract" },
  { suffix: " - Xactimate Estimate.pdf", kind: "estimate" },
  { suffix: " - Photo Report.pdf", kind: "report" },
];

export interface LocalOnlyFile {
  name: string;
  file: string;
  kind: DocumentKind;
}

export interface FileSyncResult {
  docs: (HomebaseDocument & { localFile?: string })[];
  downloaded: string[];
  toUpload: LocalOnlyFile[];
}

type Index = Record<string, { file: string; sha256: string }>;

export function sha256(file: string): string {
  return createHash("sha256").update(readFileSync(file)).digest("hex");
}

function standardKind(name: string): DocumentKind | undefined {
  return STANDARD_FILES.find((s) => name.endsWith(s.suffix))?.kind;
}

export async function syncFiles(hub: Hub, jobNumber: number): Promise<FileSyncResult> {
  if (!hub.homebase.documents || !hub.homebase.downloadDocument) return { docs: [], downloaded: [], toUpload: localOnly(hub, jobNumber, new Set()) };
  const docs = await hub.homebase.documents(jobNumber);
  const dir = hub.jobs.path(jobNumber, "homebase");
  const indexFile = path.join(dir, "index.json");
  const index: Index = existsSync(indexFile) ? JSON.parse(readFileSync(indexFile, "utf8")) : {};
  const taken = new Set(Object.values(index).map((v) => v.file));
  const downloaded: string[] = [];

  for (const doc of docs) {
    const known = index[doc.id];
    if (known && known.sha256 === doc.sha256 && existsSync(path.join(dir, known.file))) continue;
    let name = known?.file ?? safeName(doc.fileName || doc.title || doc.id);
    if (!known && taken.has(name)) name = `${doc.createdAt.slice(0, 10)} ${name}`;
    await hub.homebase.downloadDocument(doc, path.join(dir, name));
    index[doc.id] = { file: name, sha256: doc.sha256 };
    taken.add(name);
    downloaded.push(name);
    const kind = standardKind(doc.fileName);
    const target = hub.jobs.path(jobNumber, "estimate", doc.fileName);
    if (kind && !existsSync(target)) copyFileSync(path.join(dir, name), target);
  }
  writeFileSync(indexFile, JSON.stringify(index, null, 2));
  if (downloaded.length) hub.jobs.log(jobNumber, `From Homebase: ${downloaded.join(", ")}`);

  const toUpload = localOnly(hub, jobNumber, new Set(docs.map((d) => d.sha256)));
  return { docs: docs.map((d) => ({ ...d, localFile: index[d.id] ? `homebase/${index[d.id].file}` : undefined })), downloaded, toUpload };
}

function localOnly(hub: Hub, jobNumber: number, homebaseShas: Set<string>): LocalOnlyFile[] {
  return hub.jobs
    .files(jobNumber, "estimate", /\.pdf$/i)
    .map((file) => ({ file, name: path.basename(file), kind: standardKind(path.basename(file)) }))
    .filter((f): f is LocalOnlyFile => !!f.kind && !homebaseShas.has(sha256(f.file)));
}

/** Uploads the estimate files Homebase doesn't have yet (or just `names`), after asking. */
export async function uploadToHomebase(hub: Hub, jobNumber: number, names?: string[]): Promise<string[]> {
  if (!hub.homebase.uploadDocument) throw new Error("This Homebase connection can't upload files.");
  const { toUpload } = await syncFiles(hub, jobNumber);
  const pick = names?.length ? toUpload.filter((f) => names.includes(f.name)) : toUpload;
  if (!pick.length) {
    hub.say(`#${jobNumber}: Homebase already has every estimate file.`);
    return [];
  }
  const ok = await hub.approver.confirm(`Upload ${pick.length === 1 ? "this file" : `these ${pick.length} files`} to the Documents tab of Homebase #${jobNumber}?`, pick.map((f) => `${f.name} (${f.kind})`));
  if (!ok) {
    hub.say("Nothing uploaded.");
    return [];
  }
  for (const f of pick) await hub.homebase.uploadDocument(jobNumber, f.file, { kind: f.kind, title: f.name });
  hub.jobs.log(jobNumber, `To Homebase: ${pick.map((f) => f.name).join(", ")}`);
  hub.say(`Uploaded ${pick.map((f) => f.name).join(", ")} to Homebase #${jobNumber}.`);
  await syncFiles(hub, jobNumber); // record the new Homebase ids against the files
  return pick.map((f) => f.name);
}

function safeName(s: string) {
  return s.replace(/[<>:"/\\|?*\x00-\x1f]/g, "_").trim() || "document";
}
