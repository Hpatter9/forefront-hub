import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { mockDoc } from "../src/connectors/homebase/mock.js";
import { syncAll } from "../src/workflows/background.js";
import { syncFiles, uploadToHomebase } from "../src/workflows/files.js";
import { pullJob } from "../src/workflows/pull.js";
import { renderSampleEstimate, testHub } from "./helpers.js";

describe("Homebase file sync", () => {
  it("mirrors Homebase files into the folder and puts standard estimates in estimate/", async () => {
    const { hub, homebase, root } = testHub(true);
    await pullJob(hub, 9001);
    const src = path.join(root, "Sample - Reconstruction Estimate.pdf");
    writeFileSync(src, "%PDF-1.4 from homebase");
    const note = path.join(root, "adjuster letter.pdf");
    writeFileSync(note, "%PDF-1.4 letter");
    homebase.docs.set(9001, [{ doc: mockDoc(src, "estimate"), file: src }, { doc: mockDoc(note, "email"), file: note }]);

    const r = await syncFiles(hub, 9001);
    expect(r.downloaded.sort()).toEqual(["Sample - Reconstruction Estimate.pdf", "adjuster letter.pdf"]);
    expect(readFileSync(hub.jobs.path(9001, "homebase", "adjuster letter.pdf"), "utf8")).toBe("%PDF-1.4 letter");
    expect(readFileSync(hub.jobs.path(9001, "estimate", "Sample - Reconstruction Estimate.pdf"), "utf8")).toBe("%PDF-1.4 from homebase");
    expect(r.toUpload).toEqual([]);

    // Nothing new the second time.
    expect((await syncFiles(hub, 9001)).downloaded).toEqual([]);
  });

  it("never overwrites the hub's own estimate, and offers it for upload after asking", async () => {
    const { hub, homebase, approver, root } = testHub(true);
    await pullJob(hub, 9001);
    renderSampleEstimate(hub, 9001); // the hub's three PDFs
    const old = path.join(root, "Sample - Reconstruction Estimate.pdf");
    writeFileSync(old, "%PDF-1.4 an older version in homebase");
    homebase.docs.set(9001, [{ doc: mockDoc(old, "estimate"), file: old }]);

    const r = await syncFiles(hub, 9001);
    expect(readFileSync(hub.jobs.path(9001, "estimate", "Sample - Reconstruction Estimate.pdf")).subarray(0, 8).toString()).toBe("%PDF-1.4");
    expect(readFileSync(hub.jobs.path(9001, "estimate", "Sample - Reconstruction Estimate.pdf"), "utf8")).not.toContain("older version");
    expect(r.toUpload.map((f) => [f.name, f.kind]).sort()).toEqual([
      ["Sample - Reconstruction Agreement.pdf", "contract"],
      ["Sample - Reconstruction Estimate.pdf", "estimate"],
      ["Sample - Xactimate Estimate.pdf", "estimate"],
    ]);

    const up = await uploadToHomebase(hub, 9001, ["Sample - Xactimate Estimate.pdf"]);
    expect(up).toEqual(["Sample - Xactimate Estimate.pdf"]);
    expect(approver.asked.at(-1)!.action).toMatch(/Upload this file to the Documents tab of Homebase #9001/);
    expect(homebase.writes.filter((w) => w.op === "uploadDocument").map((w) => w.args)).toEqual([{ file: "Sample - Xactimate Estimate.pdf", kind: "estimate" }]);
    expect((await syncFiles(hub, 9001)).toUpload.map((f) => f.name)).not.toContain("Sample - Xactimate Estimate.pdf");
  });

  it("uploads nothing when Hunter says no", async () => {
    const { hub, homebase } = testHub(false);
    await pullJob(hub, 9001);
    renderSampleEstimate(hub, 9001);
    expect(await uploadToHomebase(hub, 9001)).toEqual([]);
    expect(homebase.writes).toEqual([]);
  });
});

describe("background sync", () => {
  it("creates folders for my open jobs, mirrors files and spots sent send-offs, without writing to Homebase", async () => {
    const { hub, homebase, gmail, root } = testHub(true);
    for (const j of homebase.jobs) j.people = { estimator: "Hunter Patterson" };
    const f = path.join(root, "Example - Xactimate Estimate.pdf");
    writeFileSync(f, "%PDF-1.4 x");
    homebase.docs.set(9002, [{ doc: mockDoc(f, "estimate"), file: f }]);

    const first = await syncAll(hub);
    expect(first.newFolders.sort()).toEqual([9001, 9002]); // 9003 is closed (Payment Received)
    expect(first.newFiles).toEqual([{ jobNumber: 9002, files: ["Example - Xactimate Estimate.pdf"] }]);
    expect(existsSync(hub.jobs.path(9002, "estimate", "Example - Xactimate Estimate.pdf"))).toBe(true);
    expect(first.errors).toEqual([]);

    // A send-off that went out shows as ready to log; Homebase is still untouched.
    renderSampleEstimate(hub, 9001);
    const { sendoff } = await import("../src/workflows/sendoff.js");
    const { TemplateWriter } = await import("../src/workflows/writer.js");
    const r = await sendoff(hub, 9001, { to: ["homeowner"], writer: new TemplateWriter(), yes: true });
    gmail.markSent(r.drafts[0].id);
    const second = await syncAll(hub);
    expect(second.newFolders).toEqual([]);
    expect(second.readyToLog).toEqual([9001]);
    expect(homebase.writes).toEqual([]);
  });
});

describe("a zip of photos dropped on a job", () => {
  it("is saved whole, and its pictures are unpacked into the job's photos folder", async () => {
    const { execFileSync } = await import("node:child_process");
    const { existsSync, mkdtempSync, readdirSync, readFileSync } = await import("node:fs");
    const os = await import("node:os");
    const nodePath = await import("node:path");
    const { addFile } = await import("../src/workflows/uploads.js");
    const { testHub, PYTHON } = await import("./helpers.js");
    const t = testHub(false); // "also add to Homebase?" -> no
    t.hub.jobs.upsert(6300, { name: "Sample" });
    const zip = nodePath.join(mkdtempSync(nodePath.join(os.tmpdir(), "zip-")), "5545290_Sample_all_images.zip");
    execFileSync(PYTHON, ["-c", "import sys,zipfile\nz=zipfile.ZipFile(sys.argv[1],'w',zipfile.ZIP_DEFLATED)\nz.writestr('rooms/kitchen 1.jpg',b'\\xff\\xd8'+b'k'*5000)\nz.writestr('rooms/bath/IMG_2.PNG',b'png'*100)\nz.writestr('__MACOSX/rooms/._kitchen 1.jpg',b'x')\nz.writestr('readme.txt',b'not a photo')\nz.close()", zip]);
    const r = await addFile(t.hub, 6300, "5545290_Sample_all_images.zip", { tmp: zip });
    expect(r).toMatchObject({ sub: "files", photos: 2, uploaded: false });
    expect(existsSync(r.file)).toBe(true);
    expect(existsSync(zip)).toBe(false); // moved, not copied
    const dir = t.hub.jobs.path(6300, "photos", "5545290_Sample_all_images");
    expect(readdirSync(dir).sort()).toEqual(["IMG_2.PNG", "kitchen 1.jpg"]);
    expect(readFileSync(nodePath.join(dir, "kitchen 1.jpg")).length).toBe(5002);
  });
});
