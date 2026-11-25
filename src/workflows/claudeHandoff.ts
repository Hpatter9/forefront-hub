import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { Hub } from "../hub.js";
import { jobDossier, sketchFiles, type JobDossier } from "./dossier.js";
import { itelLine } from "./itel.js";
import { jobWalks } from "./walks.js";

/** The folder Keystone fills with everything to attach in the Claude app, so it's one drag. */
export const HANDOFF_DIR = "for-claude";

/**
 * Estimates written in the Claude app (Hunter's own subscription and his installed forefront-estimate skill)
 * instead of inside Keystone: Keystone writes the request with everything it knows about the job, Hunter pastes it
 * into Claude with the job's files attached, and drops the PDFs Claude makes back onto the Estimator tab.
 */
export const HANDOFF_ACTIONS = {
  estimate: { label: "New estimate", ask: "Write a new reconstruction estimate for this job. Everything Keystone has on it is attached: read \"Job brief.md\" first (the emails, texts and calls boiled down to dated points, a line about every photo, my notes and the team's), then DocuSketch's floor plans (they carry the measurements), my scope walk notes, and the photo contact sheets. Use the CompanyCam connector only if you need a photo full size. Tell me what you went through and what's missing. Ask me the skill's questions before you price anything." },
  convert: { label: "Convert Xactimate PDF", ask: "Convert the attached Xactimate estimate PDF into our Reconstruction Estimate, Reconstruction Agreement and Xactimate documents." },
  agreement: { label: "Agreement + selections", ask: "Build the Reconstruction Agreement with material selections. Ask me what the homeowner picked, and set allowances for anything they still need to choose." },
  selections: { label: "Selections sign-off", ask: "Make the Material Selection Approval sheet for the homeowner to sign." },
  photos: { label: "Photo report", ask: "Make the photo report for the adjuster from the CompanyCam photos: pick the photos that show the damage and the scope, with a one-line caption each." },
  revise: { label: "Revise", ask: "Revise the estimate (estimate.json and the current PDFs are attached). The change:" },
} as const;
export type HandoffAction = keyof typeof HANDOFF_ACTIONS;

export function handoffPrompt(hub: Hub, n: number, action: HandoffAction, note = ""): { prompt: string; attach: string[] } {
  const j = hub.jobs.exists(n) ? hub.jobs.get(n) : null;
  const rel = (f: string) => path.relative(hub.jobs.folder(n), f).split(path.sep).join("/");
  const ready = path.join(hub.jobs.folder(n), HANDOFF_DIR);
  // When Keystone has put the files together (handoffPackage), that folder is what gets attached.
  const packed = existsSync(ready) ? readdirSync(ready).sort().map((f) => `${HANDOFF_DIR}/${f}`) : [];
  const attach = packed.length && (action === "estimate" || action === "revise")
    ? packed
    : j
    ? [
        ...hub.jobs.files(n, "sketch", /\.(pdf|jpe?g|png)$/i).slice(0, 4),
        ...(action === "convert" ? hub.jobs.files(n, "files", /\.pdf$/i).filter((f) => /xactimate|estimate|esx|carrier|insur/i.test(path.basename(f))).slice(0, 3) : []),
        ...(action === "revise" || action === "agreement" || action === "selections" ? hub.jobs.files(n, "estimate", /^estimate\.json$/i).slice(0, 1) : []),
        ...(action === "revise" ? hub.jobs.files(n, "estimate", /\.pdf$/i).slice(0, 3) : []),
      ].map(rel)
    : [];
  // Walk recordings' notes: site notes for a new estimate or a revision.
  const walkFiles = j && !packed.length && (action === "estimate" || action === "revise") ? jobWalks(hub, n).slice(0, 3).map((w) => w.file) : [];
  attach.push(...walkFiles);
  const lines = [
    "Use the forefront-estimate skill.",
    "",
    `Job #${n}${j?.name ? ` ${j.name}` : ""}${j?.address ? `, ${j.address}` : ""}`,
    j?.stage ? `Stage: ${j.stage}` : "",
    j?.customer.company
      ? `Customer: ${j.customer.company} (property management company; it is the customer on every document and email${j.customer.attention ? `, attention ${j.customer.attention}` : ""}): ${[j.customer.email, j.customer.phone].filter(Boolean).join(", ")}${j.occupant?.name ? `. On site: ${j.occupant.name} (owner/tenant, for access only; not the customer)` : ""}`
      : j?.customer.name ? `Customer: ${[j.customer.name, j.customer.email, j.customer.phone].filter(Boolean).join(", ")}` : "",
    j?.insurance === "oop" ? "Out of pocket (no insurance claim)." : "",
    j && (j.carrier || j.claimNumber) ? `Insurance: ${[j.carrier, j.claimNumber && `claim ${j.claimNumber}`, j.dateOfLoss && `date of loss ${j.dateOfLoss}`].filter(Boolean).join(", ")}` : "",
    j?.adjuster.name || j?.adjuster.email ? `Adjuster: ${[j.adjuster.name, j.adjuster.email, j.adjuster.phone].filter(Boolean).join(", ")}` : "",
    j?.market ? `Price list market: ${j.market}` : "",
    j?.companycamProjectId ? `CompanyCam project: ${j.companycamProjectId} (https://app.companycam.com/projects/${j.companycamProjectId}); use the CompanyCam connector for the photos.` : "",
    j?.docusketchProjectId ? `DocuSketch project: ${j.docusketchProjectId}` : "",
    attach.length ? `Attached: ${attach.map((a) => path.basename(a)).join(", ")}` : "",
    "",
    HANDOFF_ACTIONS[action].ask + (note.trim() ? ` ${note.trim()}` : ""),
    "",
    walkFiles.length || packed.some((f) => /walk/i.test(f)) ? "I'm attaching my scope walk notes (a transcript of what I said and discussed on site): use them as my site notes for the scope." : "",
    "When you're done, give me the PDFs (named with the customer's last name, as the skill says) and the estimate.json, so I can drop them into Keystone.",
  ];
  return { prompt: lines.filter((l, i, a) => l !== "" || (a[i - 1] ?? "") !== "").join("\n").trim(), attach };
}


const when = (iso: string) => (iso ? iso.slice(0, 10) : "");
/** Everything Keystone knows about the job as one readable file for Claude (made without any paid AI). */
export function briefMarkdown(d: JobDossier): string {
  const j = d.job as Record<string, any>;
  const list = (xs: string[]) => (xs.length ? xs.map((x) => `- ${x}`).join("\n") : "- (none)");
  const out: string[] = [`# Job brief: #${j.jobNumber} ${j.name}`, "", `Put together by Keystone on ${new Date().toLocaleDateString("en-US", { timeZone: "America/Denver", month: "long", day: "numeric", year: "numeric" })}. Summaries marked "digest" were written by a free assistant from the originals: where a point decides scope, quantity or price and looks off, ask Hunter.`, ""];
  out.push("## The job", list([`Address: ${j.address}`, `Stage: ${j.stage}`, j.customer?.name ? `Customer: ${[j.customer.company || j.customer.name, j.customer.attention && `attention ${j.customer.attention}`, j.customer.email, j.customer.phone].filter(Boolean).join(", ")}` : "", j.adjuster?.name ? `Adjuster: ${[j.adjuster.name, j.adjuster.email, j.adjuster.phone].filter(Boolean).join(", ")}` : "", j.carrier || j.claimNumber ? `Insurance: ${[j.carrier, j.claimNumber && `claim ${j.claimNumber}`].filter(Boolean).join(", ")}` : "", j.insurance === "oop" ? "Out of pocket (no claim)" : "", j.market ? `Price list market: ${j.market}` : ""].filter(Boolean)), "");
  if (d.missing.length) out.push("## Not checked or missing", list(d.missing), "");
  if (d.conversation) {
    out.push("## What was said: emails, texts and calls (digest)", d.conversation.summary, "", ...d.conversation.points.map((p) => `- ${p.when} · ${p.who} · ${p.kind.replace("_", " ")}: ${p.text} _(${p.source})_`), "");
  } else {
    if (d.emails.length) out.push("## Emails", ...d.emails.map((e) => `### ${when(e.at)} · ${e.who} · ${e.subject}\n${(e.body ?? "").slice(0, 1500)}`), "");
    if (d.calls.length) out.push("## Calls", list(d.calls.map((c) => `${when(c.at)} · ${c.who}: ${c.body}`)), "");
  }
  if (d.texts.length) out.push(`## Texts${d.conversation ? " (the latest; earlier ones are in the digest)" : ""}`, list(d.texts.map((t) => `${when(t.at)} · ${t.who}: ${t.text}`)), "");
  if (d.notes.jobNotes.trim()) out.push("## Hunter's job notes", d.notes.jobNotes.trim(), "");
  if (d.notes.teamNotes.length) out.push("## Team notes from Homebase", list(d.notes.teamNotes.map((x) => `${when(x.at)} · ${x.author}: ${x.body}`)), "");
  if (d.notes.walks.length) out.push("## Scope walks", list(d.notes.walks.map((w) => `${when(w.at)}: ${w.summary} (full transcript attached)`)), "");
  if (d.photos.notes?.length) {
    out.push("## Photos (digest: one line each; the numbered contact sheets are attached)");
    for (const sheet of d.photos.sheets ?? []) out.push(`### ${path.basename(sheet)}`, ...d.photos.notes.filter((p) => p.sheet === sheet).map((p) => `- #${p.number} ${p.room}: ${p.shows}`));
    out.push("");
  } else out.push("## Photos", `${d.photos.inFolder} in the job folder${d.photos.companycam.total ? `, ${d.photos.companycam.total} in CompanyCam` : ""}. ${d.photos.companycam.project ? `CompanyCam project ${d.photos.companycam.project}.` : ""}`, "");
  if (d.docusketch.length) out.push("## DocuSketch files on the job", list(d.docusketch), "");
  if (d.itel.length) out.push("## ITEL reports (attached; follow the skill's ITEL pricing rule: each applies only to the material and rooms it covers)", list(d.itel.map(itelLine)), "");
  if (d.shopStock.length) out.push("## Shop overstock that might fit (a reminder for Hunter, not part of the estimate)", list(d.shopStock), "");
  return out.join("\n").replace(/\n{3,}/g, "\n\n");
}

/**
 * Gets a job ready for the Claude app in one folder (<job>/for-claude): the brief, the DocuSketch files, the walk
 * transcripts, the photo contact sheets, and the current estimate for a revision. Uses only free work (Gemini for
 * the digest, when it's connected). Returns the folder and what's in it.
 */
export async function handoffPackage(hub: Hub, n: number): Promise<{ folder: string; files: string[]; skipped: string[] }> {
  const d = await jobDossier(hub, n);
  const root = hub.jobs.folder(n), dir = path.join(root, HANDOFF_DIR);
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, "Job brief.md"), briefMarkdown(d));
  const skipped: string[] = [];
  const add = (rel: string, as?: string) => {
    const from = path.join(root, rel);
    if (!existsSync(from)) return;
    if (statSync(from).size > 28 * 1024 * 1024) return void skipped.push(`${path.basename(rel)} (too big to attach)`);
    let name = as ?? path.basename(rel);
    for (let i = 2; existsSync(path.join(dir, name)); i++) name = `${path.basename(as ?? rel, path.extname(rel))} (${i})${path.extname(rel)}`;
    copyFileSync(from, path.join(dir, name));
  };
  // DocuSketch: its PDFs always (its .ESX is encrypted, so it isn't sent); its loose room images only when there are no contact sheets to show them.
  const sketch = sketchFiles(hub, n);
  for (const f of sketch.filter((x) => /\.pdf$/i.test(x)).slice(0, 8)) add(f);
  if (!d.photos.sheets?.length) for (const f of sketch.filter((x) => /\.(jpe?g|png)$/i.test(x)).slice(0, 12)) add(f);
  // DocuSketch's floor plans with the measurements on them are what quantities come from:
  // always in (one copy of each; the .jpg when both a .jpg and a .png exist).
  const plans = sketch.filter((x) => /(^|[\\/])(image_wall_measurements|measurements|common)_[^/]*\.(jpe?g|png)$/i.test(x));
  const stem = (x: string) => path.basename(x).replace(/\.(jpe?g|png)$/i, "").toLowerCase();
  for (const f of plans.filter((x) => /\.jpe?g$/i.test(x) || !plans.some((y) => y !== x && stem(y) === stem(x) && /\.jpe?g$/i.test(y))).slice(0, 12)) add(f, `Sketch ${path.basename(f)}`);
  // The sketch pages the current estimate prints (estimate.json "sketches"), so a revision can render them again.
  try {
    const est = JSON.parse(readFileSync(path.join(root, "estimate", "estimate.json"), "utf8"));
    for (const s of est.sketches ?? []) if (typeof s?.image === "string") add(existsSync(path.join(root, "estimate", s.image)) ? path.join("estimate", s.image) : s.image, `Estimate sketch ${path.basename(s.image)}`);
  } catch { /* no estimate yet */ }
  for (const w of d.notes.walks.slice(0, 4)) add(w.file, `Walk ${path.basename(w.file)}`);
  for (const s of d.photos.sheets ?? []) add(s, `Photos ${path.basename(s)}`);
  for (const r of d.itel) add(r.file);
  for (const f of ["estimate/estimate.json"]) add(f);
  hub.jobs.log(n, "Got the files ready for the Claude app");
  return { folder: dir, files: readdirSync(dir).sort(), skipped };
}
