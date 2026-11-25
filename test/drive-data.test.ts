import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { copyInto } from "../src/cli/driveData.js";
import { loadConfig } from "../src/core/config.js";
import { otherPcUsing, stampInUse } from "../src/workflows/inUse.js";

const tmp = () => mkdtempSync(path.join(os.tmpdir(), "ks-drive-"));

describe("Keystone's data in Google Drive", () => {
  it("reads the data folder from HUB_DATA_DIR and keeps this PC's own folder separate", () => {
    const c = loadConfig({ HUB_MODE: "mock", HUB_DATA_DIR: "G:\\My Drive\\Keystone\\Data" }, "/tmp/ks-root");
    expect(c.stateDir).toBe("G:\\My Drive\\Keystone\\Data");
    expect(c.localDir).toBe(path.join("/tmp/ks-root", ".hub"));
    expect(loadConfig({ HUB_MODE: "mock" }, "/tmp/ks-root").stateDir).toBe(path.join("/tmp/ks-root", ".hub"));
  });

  it("copies into Drive without replacing what's there, and leaves this PC's tools behind", () => {
    const from = tmp(), to = tmp();
    mkdirSync(path.join(from, "iphone-tools"), { recursive: true });
    writeFileSync(path.join(from, "iphone-tools", "python.exe"), "x");
    writeFileSync(path.join(from, "contacts.json"), "from this pc");
    writeFileSync(path.join(from, "game.json"), "from this pc");
    writeFileSync(path.join(to, "game.json"), "already in drive");
    copyInto(from, to, new Set(["iphone-tools"]));
    expect(readFileSync(path.join(to, "contacts.json"), "utf8")).toBe("from this pc");
    expect(readFileSync(path.join(to, "game.json"), "utf8")).toBe("already in drive");
    expect(existsSync(path.join(to, "iphone-tools"))).toBe(false);
    expect(readFileSync(path.join(from, "game.json"), "utf8")).toBe("from this pc"); // nothing removed from the PC
  });

  it("notices another PC using the same data, and not a stale stamp or itself", () => {
    const d = tmp(), now = Date.parse("2026-11-25T18:00:00Z");
    stampInUse(d, "OFFICE-PC", new Date(now - 5 * 60_000));
    expect(otherPcUsing(d, "LAPTOP", now)).toMatchObject({ host: "OFFICE-PC" });
    expect(otherPcUsing(d, "OFFICE-PC", now)).toBeNull();
    expect(otherPcUsing(d, "LAPTOP", now + 60 * 60_000)).toBeNull();
  });
});
