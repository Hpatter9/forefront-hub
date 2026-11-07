import type { CanUseTool, PermissionResult } from "@anthropic-ai/claude-agent-sdk";
import { existsSync, readdirSync } from "node:fs";
import path from "node:path";
import type { Hub } from "../hub.js";

/**
 * Permission policy for the agent's built-in tools. Hub tools (mcp__hub__*) are allowed here because they ask
 * Hunter themselves before anything irreversible. For files: overwriting an existing estimate (estimate.json or the
 * PDFs, via render.py) asks first and snapshots the old version to estimate/revisions/vN.
 */
export function makeGuard(hub: Hub): CanUseTool {
  const allow = (input: Record<string, unknown>): PermissionResult => ({ behavior: "allow", updatedInput: input });
  const deny = (message: string): PermissionResult => ({ behavior: "deny", message });

  return async (toolName, input) => {
    if (toolName.startsWith("mcp__hub__")) return allow(input);
    if (["Read", "Glob", "Grep", "Skill", "TodoWrite", "WebFetch", "WebSearch", "ToolSearch"].includes(toolName)) return allow(input);
    if (toolName.startsWith("mcp__")) return deny("Only Keystone's own tools are available here.");

    if (toolName === "Write" || toolName === "Edit" || toolName === "MultiEdit" || toolName === "NotebookEdit") {
      const file = String(input.file_path ?? input.notebook_path ?? "");
      if (!inside(file, hub.cfg.jobsRoot) && !inside(file, path.join(hub.cfg.hubRoot, ".hub")) && !inside(file, osTmp())) {
        return deny(`Writes are limited to the job folders (${hub.cfg.jobsRoot}).`);
      }
      if (inside(file, hub.cfg.skillDir)) return deny("The forefront-estimate skill isn't edited from Keystone.");
      if (path.basename(file) === "estimate.json" && existsSync(file)) return estimateOverwrite(hub, file, input, "Change estimate.json");
      return allow(input);
    }

    if (toolName === "Bash" || toolName === "PowerShell") {
      const cmd = String(input.command ?? "");
      if (/\b(rm\s+-rf|Remove-Item\b.*-Recurse|rmdir\s+\/s|del\s+\/s|format\s+[a-z]:|git\s+push|curl\b.*-X\s*(POST|PUT|DELETE))/i.test(cmd)) {
        return deny("That command isn't allowed from Keystone agent.");
      }
      const out = cmd.match(/render\.py\b[^\n]*?--out\s+("([^"]+)"|'([^']+)'|(\S+))/);
      // --only selections writes just the sign-off sheet, so it doesn't touch the estimate PDFs.
      const onlySelections = /--only\s+["']?selections["']?(\s|$)/.test(cmd);
      if (out && !onlySelections) {
        const dir = out[2] ?? out[3] ?? out[4];
        if (existsSync(dir) && readdirSync(dir).some((f) => / - (Reconstruction Estimate|Reconstruction Agreement|Xactimate Estimate)\.pdf$/.test(f))) {
          return estimateOverwrite(hub, path.join(dir, "estimate.json"), input, `Re-render the estimate PDFs in ${dir}`);
        }
      }
      return allow(input);
    }
    return allow(input);
  };

  async function estimateOverwrite(hub: Hub, file: string, input: Record<string, unknown>, what: string): Promise<PermissionResult> {
    const jobDir = path.dirname(path.dirname(file));
    const n = Number.parseInt(path.basename(jobDir), 10);
    const ok = await hub.approver.confirm(`${what}? This overwrites the current estimate; the old files go to estimate/revisions/.`);
    if (!ok) return deny("Hunter said not to overwrite the estimate. Ask what he wants instead.");
    if (Number.isFinite(n)) {
      const snap = hub.jobs.snapshotEstimate(n);
      if (snap) hub.say(`Saved the previous estimate to ${snap}`);
    }
    return allow(input);
  }
}

function inside(file: string, dir: string) {
  if (!file || !dir) return false;
  const rel = path.relative(path.resolve(dir), path.resolve(file));
  return !!rel && !rel.startsWith("..") && !path.isAbsolute(rel);
}

function osTmp() {
  return process.env.TEMP || process.env.TMPDIR || "/tmp";
}
