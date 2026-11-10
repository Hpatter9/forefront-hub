import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import { IphoneBackupTexts, MockTexts, textFromAttributedBody } from "../src/connectors/texts/index.js";
import { reminders } from "../src/workflows/reminders.js";
import { jobTexts, phoneKey, syncTexts } from "../src/workflows/texts.js";
import { timeline } from "../src/workflows/timeline.js";
import { testHub } from "./helpers.js";

const ago = (d: number) => new Date(Date.now() - d * 864e5).toISOString();
const SMS = "3d0d7e5fb2ce288813306e4d4636395e047a3d28";

/** A made-up iPhone backup folder with a Messages database in it. */
function fakeBackup(rows: { handle: string; text: string | null; body?: Buffer; fromMe: boolean; daysAgo: number }[], encrypted = false) {
  const dir = path.join(mkdtempSync(path.join(os.tmpdir(), "backup-")), "00008030-FAKE");
  mkdirSync(path.join(dir, SMS.slice(0, 2)), { recursive: true });
  if (encrypted) writeFileSync(path.join(dir, "Manifest.db"), Buffer.from("not a database: encrypted"));
  else new DatabaseSync(path.join(dir, "Manifest.db")).exec("CREATE TABLE Files (fileID TEXT)");
  const db = new DatabaseSync(path.join(dir, SMS.slice(0, 2), SMS));
  db.exec("CREATE TABLE handle (ROWID INTEGER PRIMARY KEY, id TEXT); CREATE TABLE message (ROWID INTEGER PRIMARY KEY, text TEXT, attributedBody BLOB, is_from_me INTEGER, date INTEGER, handle_id INTEGER)");
  const handles = [...new Set(rows.map((r) => r.handle))];
  handles.forEach((h, i) => db.prepare("INSERT INTO handle VALUES (?, ?)").run(i + 1, h));
  for (const r of rows) db.prepare("INSERT INTO message (text, attributedBody, is_from_me, date, handle_id) VALUES (?, ?, ?, ?, ?)").run(r.text, r.body ?? null, r.fromMe ? 1 : 0, BigInt(Math.round((Date.now() / 1000 - r.daysAgo * 86400 - 978307200))) * 1000000000n, handles.indexOf(r.handle) + 1);
  db.close();
  return dir;
}

describe("iPhone texts from the backup", () => {
  it("reads messages, including ones whose words are only in attributedBody", async () => {
    const body = Buffer.concat([Buffer.from("\x04\x0bstreamtyped\x81\xe8\x03\x84\x01@\x84\x84\x84\x12NSAttributedString\x00\x84\x84\x08NSObject\x00\x85\x92\x84\x84\x84\x08NSString\x01\x94\x84\x01+", "latin1"), Buffer.from([15]), Buffer.from("Running 10 late"), Buffer.from([0x86, 0x84])]);
    expect(textFromAttributedBody(body)).toBe("Running 10 late");
    const dir = fakeBackup([{ handle: "+13035550100", text: "Can we start Monday?", fromMe: false, daysAgo: 1 }, { handle: "+13035550100", text: null, body, fromMe: true, daysAgo: 2 }, { handle: "+17205559999", text: "old", fromMe: false, daysAgo: 400 }]);
    const c = new IphoneBackupTexts(dir);
    expect(c.status().connected).toBe(true);
    const list = await c.messages(new Date(Date.now() - 30 * 864e5));
    expect(list.map((m) => [m.handle, m.fromMe, m.text])).toEqual([["+13035550100", false, "Can we start Monday?"], ["+13035550100", true, "Running 10 late"]]);
    expect(Math.abs(Date.parse(list[0].at) - (Date.now() - 864e5))).toBeLessThan(5000);
  });

  it("says plainly when the backup is encrypted or missing", () => {
    expect(new IphoneBackupTexts(fakeBackup([], true)).status().problem).toMatch(/encrypted/i);
    expect(new IphoneBackupTexts(path.join(os.tmpdir(), "no-such-backup-dir")).status().problem).toMatch(/No iPhone backup/);
  });
});

describe("texts filed to jobs", () => {
  const setup = (texts: { handle: string; text: string; fromMe: boolean; daysAgo: number }[]) => {
    const t = testHub();
    t.hub.jobs.upsert(6001, { name: "Forbes", stage: "Proposal Submitted", stageSince: ago(20), customer: { name: "Dana Forbes", email: "", phone: "(303) 555-0100", company: "", attention: "" }, pulse: { lastTouchAt: ago(8), lastTouch: "emailed", checkedAt: ago(0), waiting: null } });
    t.hub.texts = new MockTexts(texts.map((x, i) => ({ id: String(i), handle: x.handle, fromMe: x.fromMe, at: ago(x.daysAgo), text: x.text })));
    return t.hub;
  };

  it("matches by phone number whatever the format, and never keeps texts from anyone else", async () => {
    expect(phoneKey("+1 (303) 555-0100")).toBe("3035550100");
    const hub = setup([{ handle: "+13035550100", text: "Sent you the estimate", fromMe: true, daysAgo: 1 }, { handle: "+17205550123", text: "dinner at 6?", fromMe: false, daysAgo: 1 }]);
    const r = await syncTexts(hub);
    expect(r).toMatchObject({ read: 2, matched: 1, jobs: [6001] });
    expect(JSON.stringify(jobTexts(hub, 6001))).not.toContain("dinner");
    expect((await timeline(hub, 6001)).find((i) => i.kind === "text")).toMatchObject({ title: "Texts with Dana Forbes (1)", body: "You: Sent you the estimate" });
  });

  it("a text you sent counts as contact: no follow-up reminder", async () => {
    const hub = setup([{ handle: "3035550100", text: "Checking in on the proposal", fromMe: true, daysAgo: 1 }]);
    expect(reminders(hub).some((x) => x.jobNumber === 6001 && x.kind === "followup")).toBe(true); // before the texts are read
    await syncTexts(hub);
    expect(reminders(hub).some((x) => x.jobNumber === 6001 && x.kind === "followup")).toBe(false);
  });

  it("a text from them with no answer is waiting on you", async () => {
    const hub = setup([{ handle: "3035550100", text: "Can you call me about the tile?", fromMe: false, daysAgo: 1 }, { handle: "3035550100", text: "Will do", fromMe: true, daysAgo: 3 }]);
    await syncTexts(hub);
    const r = reminders(hub).find((x) => x.jobNumber === 6001 && x.kind === "reply");
    expect(r).toMatchObject({ title: "Text: Can you call me about the tile?", detail: expect.stringContaining("Dana Forbes") });
  });
});

describe("a day's texts become one Homebase summary", () => {
  const setup = (answer = true) => {
    const t = testHub(answer);
    t.hub.jobs.upsert(9001, { name: "Forbes", stage: "Proposal Submitted", stageSince: ago(20), customer: { name: "Dana Forbes", email: "", phone: "303-555-0100", company: "", attention: "" } });
    t.hub.texts = new MockTexts([
      { id: "1", handle: "3035550100", fromMe: true, at: ago(1.2), text: "Can we walk it Thursday at 9?" },
      { id: "2", handle: "3035550100", fromMe: false, at: ago(1.19), text: "Yes, 9 works" },
      { id: "3", handle: "3035550100", fromMe: false, at: ago(0), text: "See you soon" }, // today: not finished yet
      { id: "4", handle: "3035550100", fromMe: true, at: ago(20), text: "old one" }, // too old to offer
    ]);
    return t;
  };

  it("asks once, posts one note per person per finished day, and doesn't ask again", async () => {
    const { logTextDays, pendingTextDays, syncTexts: sync } = await import("../src/workflows/texts.js");
    const t = setup();
    await sync(t.hub);
    expect(pendingTextDays(t.hub).map((p) => p.texts.length)).toEqual([2]);
    expect(await logTextDays(t.hub, async (p) => `Set the scope walk (${p.texts.length} texts).`)).toBe(1);
    const notes = (await t.homebase.getJob(9001).catch(() => null))?.notes ?? [];
    const writes = JSON.stringify((t.homebase as any).writes ?? notes);
    expect(writes).toMatch(/Texts with Dana Forbes \(customer\), .*: Set the scope walk \(2 texts\)\./);
    expect(pendingTextDays(t.hub)).toEqual([]);
    expect(await logTextDays(t.hub, async () => "again")).toBe(0);
    expect((await timeline(t.hub, 9001)).filter((i) => i.kind === "text").map((i) => i.title)).toEqual(["Texts with Dana Forbes (1)", "Texts with Dana Forbes (2)", "Texts with Dana Forbes (1)"]);
  });

  it("posts nothing when you say no, and doesn't offer that day again", async () => {
    const { logTextDays, pendingTextDays, syncTexts: sync } = await import("../src/workflows/texts.js");
    const t = setup(false);
    await sync(t.hub);
    expect(await logTextDays(t.hub, async () => "x")).toBe(0);
    expect(pendingTextDays(t.hub)).toEqual([]);
  });
});
