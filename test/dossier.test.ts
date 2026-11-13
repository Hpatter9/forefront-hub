import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { MockTexts } from "../src/connectors/texts/index.js";
import { jobDossier } from "../src/workflows/dossier.js";
import { syncTexts } from "../src/workflows/texts.js";
import { testHub } from "./helpers.js";

describe("everything on a job, for the estimator to go through first", () => {
  it("gathers the files, photos (the folder's and CompanyCam's), emails, texts and notes, and says what's missing", async () => {
    const t = testHub();
    t.hub.jobs.upsert(9001, { name: "Sample", address: "123 Main St, Denver, CO 80211", adjuster: { name: "Alex Adjuster", email: "alex.adjuster@carrier.example", phone: "303-555-0111", company: "", attention: "" } });
    const put = (sub: string, name: string, text = "x") => { const f = path.join(t.hub.jobs.path(9001, sub as never), name); mkdirSync(path.dirname(f), { recursive: true }); writeFileSync(f, text); };
    put("files", "Carrier estimate.pdf");
    put("photos", "all_images/kitchen 1.jpg");
    put("notes", "notes.txt", "Homeowner wants the vanity replaced, not repaired.");
    t.hub.texts = new MockTexts([{ id: "1", handle: "3035550111", fromMe: false, at: new Date().toISOString(), text: "Approved the hall bath tile" }]);
    await syncTexts(t.hub);
    const d = await jobDossier(t.hub, 9001);
    expect(d.files.files.map((f) => f.path)).toContain("Carrier estimate.pdf");
    expect(d.photos.inFolder).toBe(1); // found in a subfolder
    expect(d.photos.companycam).toMatchObject({ linked: true });
    expect(d.photos.companycam.total).toBeGreaterThan(0);
    expect(d.files.photos.some((f) => f.path.startsWith("previews/"))).toBe(true);
    expect(d.notes.jobNotes).toContain("vanity replaced");
    expect(d.emails.length).toBeGreaterThan(0);
    expect(d.emails.every((e) => e.body.length <= 1800)).toBe(true);
    expect(d.texts).toEqual([expect.objectContaining({ who: "Alex Adjuster", text: "Approved the hall bath tile" })]);
    // No .ESX, but DocuSketch's images are there: that's noted as normal, not as a blocker.
    expect(d.docusketch).toEqual(["photos/all_images/kitchen 1.jpg"]);
    expect(d.missing.join(" ")).toMatch(/No DocuSketch \.ESX \(that's normal for some jobs\)/);
  });

  it("says so when CompanyCam and texts couldn't be checked, instead of skipping them quietly", async () => {
    const t = testHub();
    t.hub.jobs.upsert(6400, { name: "Nowhere", address: "999 Unknown Rd, Pueblo, CO" });
    const d = await jobDossier(t.hub, 6400);
    expect(d.photos.companycam.linked).toBe(false);
    expect(d.missing.join(" ")).toMatch(/No CompanyCam project found/);
    expect(d.missing.join(" ")).toMatch(/texts aren't connected/);
    expect(d.missing.join(" ")).toMatch(/No photos at all/);
    expect(d.missing.join(" ")).toMatch(/No DocuSketch files found/);
  });
});
