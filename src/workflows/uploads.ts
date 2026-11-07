import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { DocumentKind } from "../connectors/homebase/types.js";
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

export async function addFile(hub: Hub, jobNumber: number, name: string, bytes: Buffer, o: { toHomebase?: boolean } = {}) {
  const safe = path.basename(name).replace(/[<>:"/\\|?*\x00-\x1f]/g, "_") || "file";
  const { sub, kind } = placeFor(safe);
  const dir = hub.jobs.path(jobNumber, sub);
  mkdirSync(dir, { recursive: true });
  let file = path.join(dir, safe);
  if (existsSync(file)) {
    const ext = path.extname(safe);
    file = path.join(dir, `${path.basename(safe, ext)} (${new Date().toISOString().slice(0, 16).replace(/[:T]/g, "-")})${ext}`);
  }
  writeFileSync(file, bytes);
  hub.jobs.log(jobNumber, `Added ${path.basename(file)} to ${sub}/`);
  hub.say(`Saved ${path.basename(file)} in #${jobNumber}'s ${sub} folder.`);
  let uploaded = false;
  if (o.toHomebase !== false && hub.homebase.uploadDocument) {
    if (await hub.approver.confirm(`Also add ${path.basename(file)} to the Documents tab of Homebase #${jobNumber}?`, [`Filed as: ${kind}`])) {
      await hub.homebase.uploadDocument(jobNumber, file, { kind, title: path.basename(file) });
      hub.jobs.log(jobNumber, `To Homebase: ${path.basename(file)}`);
      hub.say(`Added ${path.basename(file)} to Homebase #${jobNumber}.`);
      uploaded = true;
    }
  }
  return { file, sub, kind, uploaded };
}
