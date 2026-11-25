import { writeFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { handoffPrompt } from "../src/workflows/claudeHandoff.js";
import { testHub } from "./helpers.js";

describe("estimates in the Claude app", () => {
  it("writes the request with the job's details and the files to attach", () => {
    const { hub } = testHub();
    hub.jobs.upsert(3226, { name: "Augustine", address: "1071 Acapulco Ct, Colorado Springs, CO 80910", stage: "Estimating", carrier: "Farmers", claimNumber: "5045106171-1", customer: { name: "Jeremy Augustine", email: "j@example.com", phone: "" }, adjuster: { name: "Eileen Brandt", email: "eileen@claims.example", phone: "" }, companycamProjectId: "117697136", market: "CODE8X" });
    writeFileSync(hub.jobs.path(3226, "sketch", "Augustine.ESX"), "x");
    writeFileSync(hub.jobs.path(3226, "sketch", "Augustine floor plan.pdf"), "%PDF");
    const { prompt, attach } = handoffPrompt(hub, 3226, "estimate");
    expect(prompt.startsWith("Use the forefront-estimate skill.")).toBe(true);
    for (const s of ["Job #3226 Augustine, 1071 Acapulco Ct", "Farmers, claim 5045106171-1", "Adjuster: Eileen Brandt", "CompanyCam project: 117697136", "Price list market: CODE8X", "Attached: Augustine floor plan.pdf", "Ask me the skill's questions"]) expect(prompt).toContain(s);
    expect(attach).toEqual(["sketch/Augustine floor plan.pdf"]); // the encrypted .ESX is never sent
    expect(handoffPrompt(hub, 3226, "revise", "Make the hallway LVP.").prompt).toContain("The change: Make the hallway LVP.");
  });
});

describe("getting a job ready for the Claude app (the subscription)", () => {
  it("fills one folder with a brief, the DocuSketch files, walk notes and the current estimate, and the request names them", async () => {
    const { existsSync, mkdirSync, readFileSync, writeFileSync } = await import("node:fs");
    const nodePath = await import("node:path");
    const { handoffPackage, handoffPrompt, briefMarkdown } = await import("../src/workflows/claudeHandoff.js");
    const { jobDossier } = await import("../src/workflows/dossier.js");
    const { testHub } = await import("./helpers.js");
    const t = testHub();
    t.hub.jobs.upsert(9001, { name: "Sample", address: "123 Main St, Denver, CO 80211", adjuster: { name: "Alex Adjuster", email: "alex.adjuster@carrier.example", phone: "303-555-0111", company: "", attention: "" } });
    const put = (rel: string, text: string) => { const f = nodePath.join(t.hub.jobs.folder(9001), rel); mkdirSync(nodePath.dirname(f), { recursive: true }); writeFileSync(f, text); };
    put("files/Sample DocuSketch floor plan.pdf", "%PDF");
    put("notes/walks/2026-11-12 0900 walk.md", "# Scope walk\n\n## Summary\nHall bath: replace vinyl and baseboard.\n");
    put("notes/notes.txt", "Lockbox on the side gate.");
    put("estimate/estimate.json", "{}");
    const r = await handoffPackage(t.hub, 9001);
    expect(r.files).toEqual(expect.arrayContaining(["Job brief.md", "Sample DocuSketch floor plan.pdf", "Walk 2026-11-12 0900 walk.md", "estimate.json"]));
    const brief = readFileSync(nodePath.join(r.folder, "Job brief.md"), "utf8");
    expect(brief).toContain("# Job brief: #9001 Sample");
    expect(brief).toContain("Lockbox on the side gate.");
    expect(brief).toMatch(/## Emails|## What was said/);
    expect(brief).toContain("files/Sample DocuSketch floor plan.pdf");
    expect(briefMarkdown(await jobDossier(t.hub, 9001))).toContain("Adjuster: Alex Adjuster");
    const req = handoffPrompt(t.hub, 9001, "estimate");
    expect(req.attach).toContain("for-claude/Job brief.md");
    expect(req.prompt).toMatch(/read "Job brief.md" first/);
    expect(req.prompt).toMatch(/floor plans \(they carry the measurements\)/);
    expect(req.prompt).not.toMatch(/ESX/);
    // Doing it again replaces the folder rather than piling up copies.
    expect((await handoffPackage(t.hub, 9001)).files).toEqual(r.files);
    expect(existsSync(nodePath.join(r.folder, "Job brief (2).md"))).toBe(false);
  });
});
