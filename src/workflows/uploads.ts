import { copyFileSync, existsSync, mkdirSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { DocumentKind } from "../connectors/homebase/types.js";
import { unzip } from "../core/zip.js";
import type { Hub } from "../hub.js";
import { STANDARD_FILES } from "./files.js";

/**
 * Files Hunter adds by hand (dragged onto Keystone or picked with Add files): saved in the job folder where they
 * belong, then, after an OK, added to the job's Documents in Homebase.
 */
export function placeFor(name: string): { sub: "sketch" | "photos" | "estimate" | "files"; kind: DocumentKind } {
  const n = name.toLowerCase();
  if (n.endsWith(".esx")) return { sub: "sketch", kind: "scope" };
  if (/\.(jpe?g|png|heic|webp|gif)$/.test(n)) return { sub: "photos", kind: "photo" };
  const std = STANDARD_FILES.find((s) => name.endsWith(s.suffix));
  if (std) return { sub: "estimate", kind: std.kind };
  if (/agreement|contract|work auth|authorization/.test(n)) return { sub: "files", kind: "contract" };
  if (/invoice/.test(n)) return { sub: "files", kind: "invoice" };
  if (/estimate|xactimate|supplement|\bsupp\b/.test(n)) return { sub: "files", kind: "estimate" };
  if (/report|moisture|itel|lab|test/.test(n)) return { sub: "files", kind: "report" };
  if (/scope|sketch|floor ?plan/.test(n)) return { sub: "files", kind: "scope" };
  return { sub: "files", kind: "other" };
}

const IMAGE = /\.(jpe?g|png|heic|webp|gif)$/i;

/**
 * A zip of photos (DocuSketch's "all images" download, a CompanyCam export): the pictures inside go into the job's
 * photos folder, in a folder named after the zip, so the estimator and the photo report can use them. The zip
 * itself stays in files/. Returns how many pictures came out.
 */
export function unpackPhotos(hub: Hub, jobNumber: number, zipFile: string): number {
  if (statSync(zipFile).size > 1.5 * 1024 ** 3) throw new Error("That zip is too big to open here (over 1.5 GB). Unzip it on the PC and drag the pictures in.");
  const dir = hub.jobs.path(jobNumber, "photos", path.basename(zipFile, path.extname(zipFile)).replace(/[<>:"/\\|?*\x00-\x1f]/g, "_").slice(0, 80));
  let n = 0;
  for (const [name, bytes] of unzip(readFileSync(zipFile))) {
    const base = path.basename(name.replace(/\\/g, "/"));
    if (!IMAGE.test(base) || base.startsWith("._") || /(^|\/)__MACOSX\//.test(name) || !bytes.length) continue;
    mkdirSync(dir, { recursive: true });
    let out = path.join(dir, base.replace(/[<>:"/\\|?*\x00-\x1f]/g, "_"));
    for (let i = 2; existsSync(out); i++) out = path.join(dir, `${path.basename(base, path.extname(base))} (${i})${path.extname(base)}`);
    writeFileSync(out, bytes);
    n++;
  }
  return n;
}

/** `data` is the file's bytes, or a temporary file it was saved to as it arrived (big files never sit in memory). */
export async function addFile(hub: Hub, jobNumber: number, name: string, data: Buffer | { tmp: string }, o: { toHomebase?: boolean } = {}) {
  const safe = path.basename(name).replace(/[<>:"/\\|?*\x00-\x1f]/g, "_") || "file";
  const { sub, kind } = placeFor(safe);
  const dir = hub.jobs.path(jobNumber, sub);
  mkdirSync(dir, { recursive: true });
  let file = path.join(dir, safe);
  if (existsSync(file)) {
    const ext = path.extname(safe);
    file = path.join(dir, `${path.basename(safe, ext)} (${new Date().toISOString().slice(0, 16).replace(/[:T]/g, "-")})${ext}`);
  }
  if (Buffer.isBuffer(data)) writeFileSync(file, data);
  else {
    try { renameSync(data.tmp, file); } catch { copyFileSync(data.tmp, file); unlinkSync(data.tmp); }
  }
  hub.jobs.log(jobNumber, `Added ${path.basename(file)} to ${sub}/`);
  hub.say(`Saved ${path.basename(file)} in #${jobNumber}'s ${sub} folder.`);
  let photos = 0;
  if (/\.zip$/i.test(file)) {
    try {
      photos = unpackPhotos(hub, jobNumber, file);
      if (photos) {
        hub.jobs.log(jobNumber, `Unpacked ${photos} photos from ${path.basename(file)}`);
        hub.say(`Unpacked ${photos} photo${photos === 1 ? "" : "s"} from ${path.basename(file)} into #${jobNumber}'s photos folder.`);
      }
    } catch (e) {
      hub.say(`Couldn't open ${path.basename(file)}: ${(e as Error).message} The zip itself is saved.`);
    }
  }
  let uploaded = false;
  if (o.toHomebase !== false && hub.homebase.uploadDocument) {
    const mb = statSync(file).size / 1024 ** 2;
    if (await hub.approver.confirm(`Also add ${path.basename(file)} to the Documents tab of Homebase #${jobNumber}?`, [`Filed as: ${kind}`, ...(mb > 25 ? [`It's ${Math.round(mb)} MB, so Homebase may refuse it or take a while.`] : [])])) {
      await hub.homebase.uploadDocument(jobNumber, file, { kind, title: path.basename(file) });
      hub.jobs.log(jobNumber, `To Homebase: ${path.basename(file)}`);
      hub.say(`Added ${path.basename(file)} to Homebase #${jobNumber}.`);
      uploaded = true;
    }
  }
  return { file, sub, kind, uploaded, photos };
}
