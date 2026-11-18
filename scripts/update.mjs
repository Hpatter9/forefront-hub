#!/usr/bin/env node
/**
 * Keystone's updater. Runs before Keystone starts (it's the first step of `npm run app`, so it runs however
 * Keystone is launched) and brings this folder up to the latest version on GitHub. Then it does the same for the
 * Estimator folder (ESTIMATOR_DIR, C:\Games\Estimator by default), because that's where the estimating skill lives
 * and Keystone reads it from there: a skill change on GitHub reaches the PC at the next Keystone start.
 *
 * It never stops Keystone from starting: offline, no git, anything odd, it says so and carries on with the version
 * that's here. And it never throws work away: if files here were edited by hand (or by another tool) it keeps
 * those edits where they don't clash with the update; where they do clash, the edits are set aside in git's stash
 * and named in the window. Commits made here that GitHub doesn't have are kept on a branch called local-backup-*.
 *
 *   node scripts/update.mjs           update, then report
 *   node scripts/update.mjs --check   only look (Keystone only): exit code 10 when a newer version is waiting
 */
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = process.env.KEYSTONE_ROOT || path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const check = process.argv.includes("--check");
const say = (m) => console.log(`[update] ${m}`);
const stamp = new Date().toISOString().slice(0, 16).replace(/[-:T]/g, "");

// On Hunter's PC only (or when asked): a developer's working copy is never touched.
if (process.env.KEYSTONE_NO_UPDATE === "1" || (process.platform !== "win32" && process.env.KEYSTONE_UPDATE !== "1")) process.exit(0);

function gitIn(dir) {
  const git = (args) => execFileSync("git", args, { cwd: dir, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, GIT_TERMINAL_PROMPT: "0" }, timeout: 60_000 }).trim();
  const tryGit = (args) => { try { return { ok: true, out: git(args) }; } catch (e) { return { ok: false, out: String(e.stderr || e.message || "").trim() }; } };
  return { git, tryGit };
}
const about = (tryGit, rev) => tryGit(["log", "-1", "--format=%h, %cd: %s", "--date=format:%b %-d %-I:%M %p", rev]).out || tryGit(["log", "-1", "--format=%h: %s", rev]).out;

/**
 * Brings `dir` up to `branch` on GitHub. If the copy is on another branch it is moved onto `branch` (its own
 * commits kept on a backup branch). Returns { ok, updated, changes, version, notes, from, to } or { ok:false, note }.
 */
function updateRepo(dir, branch, name) {
  const { git, tryGit } = gitIn(dir);
  const fetched = tryGit(["fetch", "--quiet", "origin", branch]);
  if (!fetched.ok) return { ok: false, note: `Couldn't reach GitHub (${fetched.out.split("\n")[0].slice(0, 120) || "no connection"}).` };
  const local = git(["rev-parse", "HEAD"]);
  const remote = git(["rev-parse", "FETCH_HEAD"]);
  const notes = [];
  const current = tryGit(["symbolic-ref", "--quiet", "--short", "HEAD"]).out;
  if (current !== branch) {
    // On another branch (or none): keep where it was, then carry on from the same commit under the right name.
    if (current) notes.push(`${name} was on the branch "${current}"; it now follows "${branch}" (the old branch is still there).`);
    else { git(["branch", `local-backup-${stamp}`, local]); notes.push(`${name} wasn't on a branch; where it was is kept on local-backup-${stamp}.`); }
    git(["checkout", "-q", "-B", branch, local]);
  }
  const behind = Number(tryGit(["rev-list", "--count", `${local}..${remote}`]).out || 0);
  if (!behind) return { ok: true, updated: false, version: about(tryGit, local), notes };
  const dirty = git(["status", "--porcelain", "--untracked-files=no"]);
  const ahead = !tryGit(["merge-base", "--is-ancestor", local, remote]).ok;
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
    return { ok: false, note: `The update didn't go in: ${String(e.message).split("\n")[0].slice(0, 200)}.` };
  }
  return { ok: true, updated: true, changes: behind, version: about(tryGit, remote), notes, from: local, to: remote };
}

// ---- 1. Keystone itself ----
function updateKeystone() {
  const record = (o) => { try { mkdirSync(path.join(root, ".hub"), { recursive: true }); writeFileSync(path.join(root, ".hub", "update.json"), JSON.stringify({ at: new Date().toISOString(), ...o }, null, 1)); } catch { /* not important */ } };
  if (!existsSync(path.join(root, ".git"))) { if (!check) say("This folder isn't a git copy, so it can't update itself."); return; }
  const { tryGit } = gitIn(root);
  if (!tryGit(["--version"]).ok) { if (!check) say("Git isn't installed, so Keystone can't update itself. Run Setup Forefront Hub once."); return; }
  const branch = process.env.KEYSTONE_BRANCH || "main";
  if (check) {
    if (!tryGit(["fetch", "--quiet", "origin", branch]).ok) return;
    const behind = Number(tryGit(["rev-list", "--count", `HEAD..FETCH_HEAD`]).out || 0);
    if (behind) process.exit(10);
    return;
  }
  const r = updateRepo(root, branch, "Keystone");
  if (!r.ok) { say(`${r.note} Starting the version that's here.`); record({ ok: false, note: r.note }); return; }
  if (!r.updated) { say(`Keystone is up to date (${r.version}).`); record({ ok: true, updated: false, version: r.version }); return; }
  // New libraries only when the list of them changed.
  const changed = tryGit(["diff", "--name-only", r.from, r.to]).out.split("\n");
  if (changed.some((f) => f === "package.json" || f === "package-lock.json")) {
    say("Installing what the new version needs (a minute or so)...");
    const n = spawnSync("npm", ["install", "--no-audit", "--no-fund", "--loglevel=error"], { cwd: root, stdio: "inherit", shell: true });
    if (n.status !== 0) r.notes.push("npm install reported a problem; if Keystone doesn't start, run Setup Forefront Hub.");
  }
  say(`Updated: ${r.changes} change${r.changes === 1 ? "" : "s"}. Now at ${r.version}.`);
  for (const n of r.notes) say(n);
  record({ ok: true, updated: true, changes: r.changes, version: r.version, notes: r.notes });
}

// ---- 2. The Estimator folder (the estimating skill) ----
function envValue(key) {
  if (process.env[key]) return process.env[key];
  try {
    const m = readFileSync(path.join(root, ".env"), "utf8").match(new RegExp(`^\\s*${key}\\s*=\\s*(.*)$`, "m"));
    return m ? m[1].trim().replace(/^["']|["']$/g, "") : "";
  } catch { return ""; }
}
function updateEstimator() {
  const dir = envValue("ESTIMATOR_DIR") || (process.platform === "win32" ? "C:\\Games\\Estimator" : path.join(root, "..", "estimator"));
  if (!existsSync(dir)) return;
  const { git, tryGit } = gitIn(dir);
  const url = process.env.ESTIMATOR_REPO_URL || "https://github.com/Hpatter9/estimator.git";
  if (!existsSync(path.join(dir, ".git"))) {
    // A downloaded copy: make it a git copy of GitHub's, so it can update from now on. Files that differ from
    // GitHub's are set aside in git's stash first; the app's own data, settings and Python setup are left alone.
    try {
      git(["init", "-q"]);
      git(["remote", "add", "origin", url]);
    } catch (e) { say(`The skill folder (${dir}) couldn't be set up to update: ${String(e.message).split("\n")[0].slice(0, 160)}`); return; }
  }
  // GitHub's default branch is the one that counts.
  const head = tryGit(["ls-remote", "--symref", "origin", "HEAD"]);
  if (!head.ok) { say(`Couldn't reach GitHub for the estimating skill. Using the copy that's here.`); return; }
  const branch = process.env.ESTIMATOR_BRANCH || (head.out.match(/ref: refs\/heads\/(\S+)\s+HEAD/) || [])[1] || "main";
  if (!tryGit(["rev-parse", "--verify", "--quiet", "HEAD"]).ok) {
    // Freshly made git copy with no history yet: line it up with GitHub's version.
    const f = tryGit(["fetch", "--quiet", "origin", branch]);
    if (!f.ok) { say(`Couldn't reach GitHub for the estimating skill. Using the copy that's here.`); return; }
    git(["reset", "-q", "FETCH_HEAD"]);
    git(["checkout", "-q", "-B", branch]);
    const differs = git(["status", "--porcelain", "--untracked-files=no"]);
    if (differs) { git(["stash", "push", "-q", "-m", `keystone-auto ${stamp} (before the first update)`]); }
    say(`Estimating skill: the folder is now kept up to date from GitHub (${about(tryGit, "HEAD")}).${differs ? ` Files that were different here are set aside (git stash, "keystone-auto ${stamp}").` : ""}`);
    return;
  }
  const r = updateRepo(dir, branch, "The skill folder");
  if (!r.ok) { say(`Estimating skill: ${r.note} Using the copy that's here.`); return; }
  for (const n of r.notes) say(n);
  if (!r.updated) { say(`Estimating skill is up to date (${r.version}).`); return; }
  say(`Estimating skill updated: ${r.changes} change${r.changes === 1 ? "" : "s"}. Now at ${r.version}.`);
  const changed = tryGit(["diff", "--name-only", r.from, r.to]).out.split("\n");
  const py = path.join(dir, ".venv", process.platform === "win32" ? "Scripts\\python.exe" : "bin/python");
  if (changed.includes("requirements.txt") && existsSync(py)) spawnSync(py, ["-m", "pip", "install", "-r", "requirements.txt", "--quiet", "--disable-pip-version-check"], { cwd: dir, stdio: "inherit" });
}

updateKeystone();
if (!check && gitIn(root).tryGit(["--version"]).ok) {
  try { updateEstimator(); }
  catch (e) { say(`Estimating skill: couldn't update (${String(e.message).split("\n")[0].slice(0, 160)}). Using the copy that's here.`); }
}
process.exit(0);
