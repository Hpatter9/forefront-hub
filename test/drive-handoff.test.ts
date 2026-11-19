import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { MockDrive } from "../src/connectors/drive/index.js";
import type { FixedApprover } from "../src/core/approval.js";
import { DRIVE_ROOT, pullFromDrive, sendToDrive } from "../src/workflows/driveHandoff.js";
import { testHub } from "./helpers.js";

function setup(answer = true) {
  const t = testHub(answer);
  const root = path.join(t.hub.cfg.stateDir, "drive");
  const drive = new MockDrive(root);
  t.hub.drive = drive;
  mkdirSync(path.join(root, DRIVE_ROOT), { recursive: true }); // the folder Claude made and shared
  t.hub.jobs.upsert(9001, { name: "Sample", address: "123 Main St, Denver, CO 80211" });
  const put = (rel: string, text: string) => { const f = path.join(t.hub.jobs.folder(9001), rel); mkdirSync(path.dirname(f), { recursive: true }); writeFileSync(f, text); };
  const claude = (name: string, text: string) => { const f = path.join(root, DRIVE_ROOT, "9001 Sample", "from-claude", name); mkdirSync(path.dirname(f), { recursive: true }); writeFileSync(f, text); };
  return { ...t, root, drive, put, claude };
}

describe("writing estimates in a Claude chat through Google Drive", () => {
  it("puts the job's package and the request in Drive, mirroring the package each time", async () => {
    const { hub, root, put } = setup();
    put("notes/notes.txt", "Lockbox on the side gate.");
    put("sketch/Sample.ESX", "esx");
    const r = await sendToDrive(hub, 9001, "estimate", "Don't forget the washer and dryer reset");
    expect(r.folder).toBe(`${DRIVE_ROOT}/9001 Sample`);
    expect(r.files).toEqual(expect.arrayContaining(["Job brief.md", "Request.md", "Sample.ESX"]));
    const dir = path.join(root, DRIVE_ROOT, "9001 Sample", "for-claude");
    expect(readFileSync(path.join(dir, "Request.md"), "utf8")).toMatch(/job #9001 Sample[\s\S]*washer and dryer reset[\s\S]*from-claude/);
    expect(readFileSync(path.join(dir, "Job brief.md"), "utf8")).toContain("Lockbox on the side gate.");
    expect(existsSync(path.join(root, DRIVE_ROOT, "9001 Sample", "from-claude"))).toBe(true);
    // A stale file from an earlier send is cleared out.
    writeFileSync(path.join(dir, "old.pdf"), "x");
    await sendToDrive(hub, 9001);
    expect(existsSync(path.join(dir, "old.pdf"))).toBe(false);
  });

  it("brings Claude's files into the estimate folder once, and asks before replacing an estimate", async () => {
    const { hub, claude, put } = setup(true);
    await sendToDrive(hub, 9001);
    expect(await pullFromDrive(hub)).toEqual([]); // nothing yet
    claude("estimate.json", '{"v":1}');
    claude("Sample - Xactimate Estimate.pdf", "%PDF one");
    claude("notes.exe", "nope"); // only documents come in
    expect(await pullFromDrive(hub)).toEqual([{ jobNumber: 9001, files: ["Sample - Xactimate Estimate.pdf", "estimate.json"] }]);
    const est = (f: string) => path.join(hub.jobs.folder(9001), "estimate", f);
    expect(readFileSync(est("estimate.json"), "utf8")).toBe('{"v":1}');
    expect(existsSync(est("notes.exe"))).toBe(false);
    expect((hub.approver as FixedApprover).asked).toHaveLength(0); // nothing was there to replace
    expect(await pullFromDrive(hub)).toEqual([]); // not twice
    // A revision: asks, keeps the old one.
    await new Promise((r) => setTimeout(r, 20));
    claude("estimate.json", '{"v":2}');
    void put;
    expect((await pullFromDrive(hub))[0].files).toEqual(["estimate.json"]);
    expect((hub.approver as FixedApprover).asked.at(-1)!.action).toMatch(/Claude finished #9001 Sample\. Bring it into the job\?/);
    expect(readFileSync(est("estimate.json"), "utf8")).toBe('{"v":2}');
    expect(readFileSync(path.join(hub.jobs.folder(9001), "estimate", "revisions", "v1", "estimate.json"), "utf8")).toBe('{"v":1}');
  });

  it("leaves the files in Drive when Hunter says no, and asks again only when he presses the button", async () => {
    const { hub, claude, put } = setup(false);
    put("estimate/estimate.json", '{"mine":true}');
    await sendToDrive(hub, 9001);
    claude("estimate.json", '{"v":9}');
    expect(await pullFromDrive(hub)).toEqual([]);
    const asked = (hub.approver as FixedApprover).asked.length;
    expect(await pullFromDrive(hub)).toEqual([]); // the 2-minute check doesn't nag
    expect((hub.approver as FixedApprover).asked.length).toBe(asked);
    await pullFromDrive(hub, 9001); // the button asks again
    expect((hub.approver as FixedApprover).asked.length).toBe(asked + 1);
    expect(readFileSync(path.join(hub.jobs.folder(9001), "estimate", "estimate.json"), "utf8")).toBe('{"mine":true}');
  });

  it("says what to do when Drive isn't allowed yet or the folder isn't shared", async () => {
    const { hub, drive, root } = setup();
    drive.on = false;
    await expect(sendToDrive(hub, 9001)).rejects.toThrow(/Connect Gmail.*allow Google Drive/);
    drive.on = true;
    const { rmSync } = await import("node:fs");
    rmSync(path.join(root, DRIVE_ROOT), { recursive: true });
    await expect(sendToDrive(hub, 9001)).rejects.toThrow(/can't see the "Keystone hand-off" folder.*shared with/);
  });
});
