#!/usr/bin/env node
/**
 * Keystone's updater. Runs before Keystone starts (it's the first step of `npm run app`, so it runs however
 * Keystone is launched) and brings this folder up to the latest version on GitHub.
 *
 * It never stops Keystone from starting: offline, no git, anything odd, it says so and carries on with the version
 * that's here. And it never throws work away: if files here were edited by hand (or by another tool) it keeps
 * those edits where they don't clash with the update; where they do clash, the edits are set aside in git's stash
 * and named in the window. Commits made here that GitHub doesn't have are kept on a branch called local-backup-*.
 *
 *   node scripts/update.mjs           update, then report
 *   node scripts/update.mjs --check   only look: exit code 10 when a newer version is waiting
 */
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = process.env.KEYSTONE_ROOT || path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const check = process.argv.includes("--check");
const say = (m) => console.log(`[update] ${m}`);
const git = (args, opts = {}) => execFileSync("git", args, { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, GIT_TERMINAL_PROMPT: "0" }, timeout: 60_000, ...opts }).trim();
const tryGit = (args) => { try { return { ok: true, out: git(args) }; } catch (e) { return { ok: false, out: String(e.stderr || e.message || "").trim() }; } };
const record = (o) => { try { mkdirSync(path.join(root, ".hub"), { recursive: true }); writeFileSync(path.join(root, ".hub", "update.json"), JSON.stringify({ at: new Date().toISOString(), ...o }, null, 1)); } catch { /* not important */ } };
const done = (code = 0) => process.exit(code);

// On Hunter's PC only (or when asked): a developer's working copy is never touched.
if (process.env.KEYSTONE_NO_UPDATE === "1" || (process.platform !== "win32" && process.env.KEYSTONE_UPDATE !== "1")) done();
if (!existsSync(path.join(root, ".git"))) { if (!check) say("This folder isn't a git copy, so it can't update itself."); done(); }
if (!tryGit(["--version"]).ok) { if (!check) say("Git isn't installed, so Keystone can't update itself. Run Setup Forefront Hub once."); done(); }

const branch = process.env.KEYSTONE_BRANCH || "main";
const fetched = tryGit(["fetch", "--quiet", "origin", branch]);
if (!fetched.ok) {
  if (!check) say(`Couldn't reach GitHub (${fetched.out.split("\n")[0].slice(0, 120) || "no connection"}). Starting the version that's here.`);
  record({ ok: false, note: "Couldn't reach GitHub." });
  done();
}
const local = git(["rev-parse", "HEAD"]);
const remote = git(["rev-parse", "FETCH_HEAD"]);
const about = (rev) => tryGit(["log", "-1", "--format=%h, %cd: %s", "--date=format:%b %-d %-I:%M %p", rev]).out || tryGit(["log", "-1", "--format=%h: %s", rev]).out;
const behind = Number(tryGit(["rev-list", "--count", `${local}..${remote}`]).out || 0);
if (!behind) {
  if (!check) say(`Keystone is up to date (${about(local)}).`);
  record({ ok: true, updated: false, version: about(local) });
  done();
}
if (check) done(10);

const notes = [];
const dirty = git(["status", "--porcelain", "--untracked-files=no"]);
const ahead = !tryGit(["merge-base", "--is-ancestor", local, remote]).ok;
const stamp = new Date().toISOString().slice(0, 16).replace(/[-:T]/g, "");
try {
  if (ahead) {
    // Commits here that GitHub doesn't have: keep them on a branch, then take GitHub's version.
    git(["branch", `local-backup-${stamp}`, local]);
    if (dirty) git(["stash", "push", "-m", `keystone-auto ${stamp}`]);
    git(["reset", "--hard", remote]);
    notes.push(`This copy had its own commits; they're kept on the branch local-backup-${stamp}.`);
    if (dirty) notes.push(`Hand edits were set aside (git stash, "keystone-auto ${stamp}").`);
  } else {
    // The usual case. Works as-is when hand edits don't touch the files the update changes.
    let ff = tryGit(["merge", "--ff-only", "--quiet", remote]);
    if (!ff.ok && dirty) {
      git(["stash", "push", "-m", `keystone-auto ${stamp}`]);
      ff = tryGit(["merge", "--ff-only", "--quiet", remote]);
      if (!ff.ok) throw new Error(ff.out);
      // Put the edits back on top of the new version; where they clash, the new version wins and the edits stay in the stash.
      const pop = tryGit(["stash", "pop"]);
      if (!pop.ok) {
        git(["reset", "--hard", "--quiet", "HEAD"]); // back to the clean new version; the edits are still in the stash
        notes.push(`Some files here had been edited and clashed with the update: ${dirty.split("\n").map((l) => l.trim().replace(/^\S+\s+/, "")).slice(0, 6).join(", ")}. The update was used; the edits are set aside (git stash, "keystone-auto ${stamp}").`);
      }
    } else if (!ff.ok) throw new Error(ff.out);
  }
} catch (e) {
  say(`The update didn't go in: ${String(e.message).split("\n")[0].slice(0, 200)}. Starting the version that's here.`);
  record({ ok: false, note: String(e.message).slice(0, 300) });
  done();
}

// New libraries only when the list of them changed.
const changed = tryGit(["diff", "--name-only", local, remote]).out.split("\n");
if (changed.some((f) => f === "package.json" || f === "package-lock.json")) {
  say("Installing what the new version needs (a minute or so)...");
  const r = spawnSync("npm", ["install", "--no-audit", "--no-fund", "--loglevel=error"], { cwd: root, stdio: "inherit", shell: true });
  if (r.status !== 0) notes.push("npm install reported a problem; if Keystone doesn't start, run Setup Forefront Hub.");
}
say(`Updated: ${behind} change${behind === 1 ? "" : "s"}. Now at ${about(remote)}.`);
for (const n of notes) say(n);
record({ ok: true, updated: true, changes: behind, version: about(remote), notes });
done();
