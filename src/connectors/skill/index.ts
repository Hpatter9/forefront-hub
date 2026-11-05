import { spawn } from "node:child_process";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readlinkSync, rmSync, symlinkSync } from "node:fs";
import os from "node:os";
import path from "node:path";

/**
 * The forefront-estimate skill (in the estimator repo) does all the estimating. The agent runs it through the Skill
 * tool; the hub's own code only calls its standalone scripts for deterministic steps (totals, the photo report).
 * Nothing here prices or scopes anything.
 */
export interface ScriptResult {
  code: number;
  stdout: string;
  stderr: string;
}

export interface ScopeTotal {
  title: string; // "Base Scope" or "Optional — Pantry Repairs"
  customerTotal: number; // with markup: what the Reconstruction Estimate shows
  xactimateTotal: number; // no markup: what the Xactimate Estimate shows
}

export class EstimateSkill {
  constructor(readonly skillDir: string, private python: string) {}

  get scripts() {
    return path.join(this.skillDir, "scripts");
  }

  check(): string | null {
    if (!existsSync(path.join(this.skillDir, "SKILL.md"))) return `forefront-estimate skill not found at ${this.skillDir} (set ESTIMATOR_DIR in .env)`;
    if (!existsSync(path.join(this.scripts, "photo_report.py"))) return "The skill has no scripts/photo_report.py. Pull the latest estimator repo.";
    return null;
  }

  run(script: string, args: string[], cwd?: string): Promise<ScriptResult> {
    const [cmd, ...pre] = this.python.split(/\s+/);
    return new Promise((resolve, reject) => {
      const p = spawn(cmd, [...pre, path.join(this.scripts, script), ...args], { cwd, env: { ...process.env, PYTHONIOENCODING: "utf-8" } });
      let stdout = "";
      let stderr = "";
      p.stdout.on("data", (d) => (stdout += d));
      p.stderr.on("data", (d) => (stderr += d));
      p.on("error", reject);
      p.on("close", (code) => resolve({ code: code ?? 1, stdout, stderr }));
    });
  }

  /** The totals render.py prints for estimate.json (rendered to a temp folder, so the job's PDFs aren't touched). */
  async totals(estimateJson: string): Promise<ScopeTotal[]> {
    const tmp = mkdtempSync(path.join(os.tmpdir(), "hub-totals-"));
    try {
      const r = await this.run("render.py", [estimateJson, "--out", tmp, "--only", "estimate"]);
      if (r.code !== 0) throw new Error(`render.py failed: ${r.stderr || r.stdout}`);
      return parseTotals(r.stdout);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  }

  async photoReport(o: { picks: string; photosDir: string; estimateJson?: string; outDir: string; perPage?: number }): Promise<string> {
    const args = [o.picks, "--photos", o.photosDir, "--out", o.outDir];
    if (o.estimateJson && existsSync(o.estimateJson)) args.push("--estimate", o.estimateJson);
    if (o.perPage) args.push("--per-page", String(o.perPage));
    const r = await this.run("photo_report.py", args);
    const out = r.stdout.match(/^-> (.+)$/m)?.[1]?.trim();
    if (r.code !== 0 || !out) throw new Error(`photo_report.py failed: ${r.stderr || r.stdout}`);
    return out;
  }

  /**
   * Makes the skill visible to the agent: <hub>/.claude/skills/forefront-estimate -> the estimator repo's copy
   * (a junction on Windows, so no admin rights are needed). Pulling the estimator repo updates the hub at once.
   */
  link(hubRoot: string): string {
    const dest = path.join(hubRoot, ".claude", "skills", "forefront-estimate");
    mkdirSync(path.dirname(dest), { recursive: true });
    if (existsSync(dest) || isLink(dest)) {
      if (isLink(dest) && path.resolve(readlinkSync(dest)) === path.resolve(this.skillDir)) return dest;
      rmSync(dest, { recursive: !isLink(dest), force: true });
    }
    symlinkSync(this.skillDir, dest, process.platform === "win32" ? "junction" : "dir");
    return dest;
  }
}

function isLink(p: string) {
  try {
    return lstatSync(p).isSymbolicLink();
  } catch {
    return false;
  }
}

export function parseTotals(stdout: string): ScopeTotal[] {
  const out: ScopeTotal[] = [];
  const re = /^(Base Scope|Optional — .+?): \$([\d,]+\.\d{2})\s+\(Xactimate-style, no markup: \$([\d,]+\.\d{2})\)/gm;
  for (const m of stdout.matchAll(re)) {
    out.push({ title: m[1], customerTotal: Number(m[2].replace(/,/g, "")), xactimateTotal: Number(m[3].replace(/,/g, "")) });
  }
  return out;
}
