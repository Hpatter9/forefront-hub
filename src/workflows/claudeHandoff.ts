import path from "node:path";
import type { Hub } from "../hub.js";

/**
 * Estimates written in the Claude app (Hunter's own subscription and his installed forefront-estimate skill)
 * instead of inside Keystone: Keystone writes the request with everything it knows about the job, Hunter pastes it
 * into Claude with the job's files attached, and drops the PDFs Claude makes back onto the Estimator tab.
 */
export const HANDOFF_ACTIONS = {
  estimate: { label: "New estimate", ask: "Write a new reconstruction estimate for this job from the attached DocuSketch ESX (or pull the sketch from DocuSketch) and the CompanyCam photos. Ask me the skill's questions before you price anything." },
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
  const attach = j
    ? [
        ...hub.jobs.files(n, "sketch", /\.esx$/i).slice(0, 2),
        ...(action === "convert" ? hub.jobs.files(n, "files", /\.pdf$/i).filter((f) => /xactimate|estimate|esx|carrier|insur/i.test(path.basename(f))).slice(0, 3) : []),
        ...(action === "revise" || action === "agreement" || action === "selections" ? hub.jobs.files(n, "estimate", /^estimate\.json$/i).slice(0, 1) : []),
        ...(action === "revise" ? hub.jobs.files(n, "estimate", /\.pdf$/i).slice(0, 3) : []),
      ].map(rel)
    : [];
  const lines = [
    "Use the forefront-estimate skill.",
    "",
    `Job #${n}${j?.name ? ` ${j.name}` : ""}${j?.address ? `, ${j.address}` : ""}`,
    j?.stage ? `Stage: ${j.stage}` : "",
    j?.customer.name ? `Customer: ${[j.customer.name, j.customer.email, j.customer.phone].filter(Boolean).join(", ")}` : "",
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
    "When you're done, give me the PDFs (named with the customer's last name, as the skill says) and the estimate.json, so I can drop them into Keystone.",
  ];
  return { prompt: lines.filter((l, i, a) => l !== "" || (a[i - 1] ?? "") !== "").join("\n").trim(), attach };
}
