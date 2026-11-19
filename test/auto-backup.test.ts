import { mkdirSync, utimesSync, writeFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { MockPhoneBackup, lastLines, parseDevices } from "../src/connectors/iphoneBackup/index.js";
import { IphoneBackupTexts } from "../src/connectors/texts/index.js";
import { autoBackup, backupRootFor } from "../src/workflows/autoBackup.js";
import { testHub } from "./helpers.js";

/** A PC with one phone's backup folder, last backed up `hoursAgo`. */
function setup(hoursAgo: number | null) {
  const t = testHub();
  const root = path.join(t.hub.cfg.stateDir, "Backup"), dir = path.join(root, "00008140-ABC");
  mkdirSync(root, { recursive: true });
  const touch = (h: number) => { mkdirSync(dir, { recursive: true }); const f = path.join(dir, "Manifest.db"); writeFileSync(f, "x"); const at = new Date(Date.now() - h * 3600e3); utimesSync(f, at, at); };
  if (hoursAgo !== null) touch(hoursAgo);
  t.hub.cfg.texts = { ...t.hub.cfg.texts, enabled: true, backupDir: root, autoBackup: true };
  t.hub.texts = new IphoneBackupTexts(root, "pw");
  const phone = new MockPhoneBackup([{ udid: "00008140-ABC", name: "hpatt's iPhone" }], () => touch(0));
  t.hub.phoneBackup = phone;
  return { ...t, root, phone };
}

describe("backing the iPhone up by itself", () => {
  it("backs up a plugged-in phone whose backup is old, into the folder its backup is already in", async () => {
    const { hub, phone, root, said } = setup(30);
    expect(await autoBackup(hub)).toBe("done");
    expect(phone.backups).toEqual([{ udid: "00008140-ABC", root }]);
    expect(said.join("\n")).toMatch(/backing it up now[\s\S]*passcode[\s\S]*Texts are current/);
    expect(await autoBackup(hub)).toBe("fresh"); // not again until it's old
    expect(phone.backups).toHaveLength(1);
  });

  it("leaves a fresh backup alone, and does nothing when no phone is plugged in", async () => {
    const fresh = setup(1);
    expect(await autoBackup(fresh.hub)).toBe("fresh");
    expect(await autoBackup(fresh.hub, { force: true })).toBe("done"); // "back up now"
    const none = setup(30);
    none.phone.plugged = [];
    expect(await autoBackup(none.hub)).toBe("no-phone");
    expect(none.said).toEqual([]);
  });

  it("says why once when it fails, waits an hour, and never blocks texts", async () => {
    const { hub, phone, said } = setup(30);
    phone.fail = "Device is locked";
    expect(await autoBackup(hub)).toBe("failed");
    expect(said.at(-1)).toMatch(/didn't finish \(Device is locked\).*Apple Devices still works/);
    expect(await autoBackup(hub)).toBe("waiting");
    phone.fail = null;
    expect(await autoBackup(hub, { now: new Date(Date.now() + 61 * 60_000) })).toBe("done");
    const broken = setup(30);
    broken.phone.problem = "Couldn't install the iPhone tool (no internet).";
    expect(await autoBackup(broken.hub)).toBe("setup-failed");
    expect(await autoBackup(broken.hub)).toBe("waiting");
    expect(broken.said.filter((x) => /isn't working yet/.test(x))).toHaveLength(1);
  });

  it("is off when texts or auto-backup are off", async () => {
    const { hub } = setup(30);
    hub.phoneBackup = null;
    expect(await autoBackup(hub)).toBe("off");
  });

  it("finds the phone's folder under Apple's backup places, and reads the tool's device list", () => {
    const t = testHub();
    t.hub.cfg.texts = { ...t.hub.cfg.texts, backupDir: "" };
    const home = path.join(t.hub.cfg.stateDir, "home");
    const itunes = path.join(home, "AppData", "Roaming", "Apple Computer", "MobileSync", "Backup");
    mkdirSync(path.join(itunes, "00008140ABC"), { recursive: true });
    expect(backupRootFor(t.hub, "00008140-ABC", { USERPROFILE: home })).toBe(itunes);
    expect(backupRootFor(t.hub, "other", { USERPROFILE: home })).toBe(itunes); // the one that exists
    expect(parseDevices('log line\n[{"DeviceName": "hpatt\'s iPhone", "Identifier": "00008140-ABC", "ConnectionType": "USB"}, {"Identifier": "00008140-ABC"}]')).toEqual([{ udid: "00008140-ABC", name: "hpatt's iPhone" }]);
    expect(parseDevices('["00008140-ABC"]')).toEqual([{ udid: "00008140-ABC", name: "iPhone" }]);
    expect(parseDevices("ERROR Failed to connect to usbmuxd")).toEqual([]);
    expect(lastLines("a\n\n\x1b[31mERROR boom\x1b[0m\n")).toBe("a | ERROR boom");
  });
});
