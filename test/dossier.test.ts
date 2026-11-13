import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
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
    expect(d.emails.every((e) => (e.body ?? "").length <= 1800)).toBe(true);
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

describe("reading done ahead by the free AI", () => {
  it("hands the estimator a digest of the emails and a line per photo, keeps them, and only redoes them when something changes", async () => {
    const { MockGemini } = await import("../src/connectors/gemini/index.js");
    const { ESTIMATOR_DIR } = await import("./helpers.js");
    const { mkdirSync: mk, writeFileSync: wr, existsSync: ex } = await import("node:fs");
    const { execFileSync } = await import("node:child_process");
    const t = testHub();
    t.hub.cfg.skillDir = path.join(ESTIMATOR_DIR, "skill", "forefront-estimate");
    t.hub.cfg.ai = { provider: "gemini", geminiKey: "k", geminiModel: "main", geminiFastModel: "fast" };
    t.hub.jobs.upsert(9001, { name: "Sample", address: "123 Main St, Denver, CO 80211", adjuster: { name: "Alex Adjuster", email: "alex.adjuster@carrier.example", phone: "303-555-0111", company: "", attention: "" } });
    // Enough texting that a digest is worth making, and two real (tiny) photos.
    t.hub.texts = new MockTexts(Array.from({ length: 40 }, (_, i) => ({ id: String(i), handle: "3035550111", fromMe: i % 2 === 0, at: new Date(Date.now() - (40 - i) * 3600e3).toISOString(), text: `Message ${i}: the tub wall drywall is wet up to 4 feet, replace the lower half only. `.repeat(3) })));
    await syncTexts(t.hub);
    const photos = t.hub.jobs.path(9001, "photos");
    mk(path.join(photos, "zip"), { recursive: true });
    execFileSync("python3", ["-c", "import sys\nfrom PIL import Image\nfor p in sys.argv[1:]: Image.new('RGB',(320,240),(90,120,150)).save(p)", path.join(photos, "zip", "a.jpg"), path.join(photos, "zip", "b.jpg")]);
    let calls = 0;
    t.hub.gemini = new MockGemini((req) => {
      calls++;
      const withImages = JSON.stringify(req.contents).includes("inlineData");
      return withImages
        ? JSON.stringify({ photos: Array.from({ length: 12 }, (_, i) => ({ number: i + 1, room: "Hall bath", shows: `photo ${i + 1}: flood cut on the tub wall` })) })
        : JSON.stringify({ summary: "The adjuster agreed to the lower half of the tub wall.", points: [{ when: "2026-11-10", who: "Alex Adjuster", kind: "agreed", text: "Replace the lower 4 ft of drywall on the tub wall only.", source: "text" }] });
    });
    const d = await jobDossier(t.hub, 9001);
    expect(d.conversation).toMatchObject({ summary: expect.stringContaining("lower half"), points: [expect.objectContaining({ kind: "agreed", source: "text" })] });
    expect(d.emails.length).toBeGreaterThan(0);
    expect(d.emails.every((e) => e.body === undefined && e.subject !== undefined)).toBe(true); // headers only; the digest has the substance
    expect(d.texts.length).toBeLessThanOrEqual(30);
    expect(d.photos.sheets![0]).toBe("photos/sheets/sheet_01.jpg");
    expect(ex(path.join(t.hub.jobs.folder(9001), d.photos.sheets![0]))).toBe(true);
    expect(d.photos.notes!.some((p) => p.file === "photos/zip/a.jpg" && p.room === "Hall bath" && /flood cut/.test(p.shows))).toBe(true);
    expect(d.photos.howTo).toMatch(/Don't run photo_sheets.py again/);
    const first = calls;
    expect(first).toBe(2);
    // Nothing changed: the saved digest and notes are used, no new AI calls.
    await jobDossier(t.hub, 9001);
    expect(calls).toBe(first);
    // A new photo: only the photo notes are redone.
    wr(path.join(photos, "zip", "c.jpg"), readFileSync(path.join(photos, "zip", "a.jpg")));
    await jobDossier(t.hub, 9001);
    expect(calls).toBe(first + 1);
  });

  it("falls back to the originals when the free AI fails", async () => {
    const { MockGemini } = await import("../src/connectors/gemini/index.js");
    const t = testHub();
    t.hub.cfg.ai = { provider: "gemini", geminiKey: "k", geminiModel: "main", geminiFastModel: "fast" };
    t.hub.jobs.upsert(9001, { name: "Sample", address: "123 Main St, Denver, CO 80211", adjuster: { name: "Alex Adjuster", email: "alex.adjuster@carrier.example", phone: "303-555-0111", company: "", attention: "" } });
    t.hub.texts = new MockTexts(Array.from({ length: 40 }, (_, i) => ({ id: String(i), handle: "3035550111", fromMe: false, at: new Date(Date.now() - (40 - i) * 3600e3).toISOString(), text: "A long message about the tub wall. ".repeat(8) })));
    await syncTexts(t.hub);
    t.hub.gemini = new MockGemini(() => { throw new Error("the request was refused"); });
    const d = await jobDossier(t.hub, 9001);
    expect(d.conversation).toBeUndefined();
    expect(d.emails.some((e) => (e.body ?? "").length > 0)).toBe(true);
    expect(d.texts.length).toBe(40);
  });
});
