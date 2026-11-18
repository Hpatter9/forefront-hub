import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";

const SCRIPT = path.resolve("scripts", "update.mjs");
const g = (cwd: string, ...args: string[]) => execFileSync("git", ["-c", "user.name=Test", "-c", "user.email=t@example.com", "-c", "commit.gpgsign=false", ...args], { cwd, encoding: "utf8" }).trim();

/** A pretend GitHub, a publisher that pushes new versions to it, and the copy on Hunter's PC. */
function world() {
  const base = mkdtempSync(path.join(os.tmpdir(), "ks-update-"));
  const remote = path.join(base, "remote.git"), pub = path.join(base, "pub"), pc = path.join(base, "pc");
  execFileSync("git", ["init", "--bare", "-b", "main", remote]);
  execFileSync("git", ["clone", "-q", remote, pub]);
  writeFileSync(path.join(pub, "app.txt"), "v1\n"); writeFileSync(path.join(pub, "start.bat"), "start v1\n");
  g(pub, "add", "."); g(pub, "commit", "-qm", "v1"); g(pub, "push", "-q", "origin", "HEAD:main");
  execFileSync("git", ["clone", "-q", remote, pc]);
  const publish = (file: string, text: string, msg: string) => { writeFileSync(path.join(pub, file), text); g(pub, "add", "."); g(pub, "commit", "-qm", msg); g(pub, "push", "-q", "origin", "HEAD:main"); };
  const run = (...args: string[]) => spawnSync(process.execPath, [SCRIPT, ...args], { encoding: "utf8", env: { ...process.env, KEYSTONE_ROOT: pc, KEYSTONE_UPDATE: "1", KEYSTONE_NO_UPDATE: "" } });
  const read = (f: string) => readFileSync(path.join(pc, f), "utf8");
  return { pc, publish, run, read };
}

describe("Keystone's updater (runs before every start)", () => {
  it("brings a clean copy up to the newest version, and says so when there's nothing new", () => {
    const w = world();
    expect(w.run().stdout).toMatch(/up to date/);
    w.publish("app.txt", "v2\n", "second version");
    expect(w.run("--check").status).toBe(10);
    expect(w.read("app.txt")).toBe("v1\n"); // --check only looks
    const r = w.run();
    expect(r.status).toBe(0);
    expect(r.stdout).toMatch(/Updated: 1 change/);
    expect(w.read("app.txt")).toBe("v2\n");
    expect(JSON.parse(w.read(".hub/update.json"))).toMatchObject({ ok: true, updated: true, changes: 1 });
    expect(w.run("--check").status).toBe(0);
  });

  it("still updates when files here were edited by hand, keeping edits that don't clash", () => {
    const w = world();
    writeFileSync(path.join(w.pc, "start.bat"), "start my own way\n"); // another tool changed how Keystone starts
    w.publish("app.txt", "v2\n", "second version");
    expect(w.run().stdout).toMatch(/Updated: 1 change/);
    expect(w.read("app.txt")).toBe("v2\n");
    expect(w.read("start.bat")).toBe("start my own way\n");
  });

  it("when a hand edit clashes with the update, the update wins and the edit is set aside, not lost", () => {
    const w = world();
    writeFileSync(path.join(w.pc, "start.bat"), "start my own way\n");
    w.publish("start.bat", "start v2\n", "new start file");
    const r = w.run();
    expect(r.stdout).toMatch(/Updated: 1 change/);
    expect(r.stdout).toMatch(/clashed with the update: start\.bat/);
    expect(w.read("start.bat")).toBe("start v2\n");
    expect(g(w.pc, "stash", "list")).toMatch(/keystone-auto/);
    expect(g(w.pc, "stash", "show", "-p", "stash@{0}")).toContain("start my own way");
    expect(g(w.pc, "status", "--porcelain", "--untracked-files=no")).toBe("");
  });

  it("keeps commits made on this PC on a backup branch and still takes the new version", () => {
    const w = world();
    writeFileSync(path.join(w.pc, "app.txt"), "local\n"); g(w.pc, "commit", "-qam", "a local commit");
    w.publish("app.txt", "v2\n", "second version");
    const r = w.run();
    expect(r.stdout).toMatch(/kept on the branch local-backup-/);
    expect(w.read("app.txt")).toBe("v2\n");
    expect(g(w.pc, "branch", "--list", "local-backup-*")).toMatch(/local-backup-/);
  });

  it("never blocks the start: offline, it says so and carries on", () => {
    const w = world();
    g(w.pc, "remote", "set-url", "origin", path.join(w.pc, "nowhere.git"));
    const r = w.run();
    expect(r.status).toBe(0);
    expect(r.stdout).toMatch(/Couldn't reach GitHub/);
    expect(w.read("app.txt")).toBe("v1\n");
  });

  it("leaves a developer's copy alone unless asked", () => {
    const w = world();
    w.publish("app.txt", "v2\n", "second version");
    const r = spawnSync(process.execPath, [SCRIPT], { encoding: "utf8", env: { ...process.env, KEYSTONE_ROOT: w.pc, KEYSTONE_NO_UPDATE: "1", KEYSTONE_UPDATE: "1" } });
    expect(r.status).toBe(0);
    expect(w.read("app.txt")).toBe("v1\n");
  });
});
