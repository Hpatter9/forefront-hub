import { spawn } from "node:child_process";
import { existsSync, mkdirSync } from "node:fs";
import path from "node:path";
import type { Config } from "../../core/config.js";

/**
 * Starting an iPhone backup from Keystone, so texts stay fresh without clicking Back Up Now. Uses the free
 * pymobiledevice3 tool (github.com/doronz88/pymobiledevice3), installed on first use into Keystone's own private
 * Python folder (.hub/iphone-tools), talking to the phone through Apple's own driver (installed with Apple
 * Devices). It makes the same kind of backup, in the same folder, as Apple Devices does: only what changed since
 * the last one. Nothing is ever changed on the phone.
 */
export interface PhoneDevice { udid: string; name: string }
export interface PhoneBackup {
  readonly kind: "pymobiledevice3" | "mock";
  /** Gets the tool ready (installs it the first time). Returns what went wrong, or null. */
  ready(): Promise<string | null>;
  /** iPhones plugged into this PC by cable right now. */
  devices(): Promise<PhoneDevice[]>;
  /** Backs the phone up into `root` (the folder that holds one folder per phone). Rejects with the tool's last lines. */
  backup(udid: string, root: string): Promise<void>;
}

function run(cmd: string, args: string[], timeoutMs: number): Promise<{ code: number | null; out: string }> {
  return new Promise((resolve) => {
    let out = "";
    let child;
    try {
      child = spawn(cmd, args, { env: { ...process.env, PYTHONIOENCODING: "utf-8", NO_COLOR: "1" }, windowsHide: true });
    } catch (e) {
      return resolve({ code: -1, out: (e as Error).message });
    }
    const take = (b: Buffer) => { out = (out + b.toString("utf8")).slice(-20_000); };
    child.stdout.on("data", take);
    child.stderr.on("data", take);
    const timer = setTimeout(() => { child.kill(); out += "\n(stopped: took too long)"; }, timeoutMs);
    child.on("error", (e) => { clearTimeout(timer); resolve({ code: -1, out: e.message }); });
    child.on("close", (code) => { clearTimeout(timer); resolve({ code, out }); });
  });
}

/** The devices in `usbmux list` output: a JSON list of UDIDs, or of objects with Identifier / DeviceName. */
export function parseDevices(out: string): PhoneDevice[] {
  const a = out.indexOf("["), b = out.lastIndexOf("]");
  if (a < 0 || b <= a) return [];
  try {
    const list = JSON.parse(out.slice(a, b + 1)) as unknown[];
    const seen = new Set<string>();
    return list
      .map((d) => (typeof d === "string" ? { udid: d, name: "iPhone" } : { udid: String((d as any).Identifier ?? (d as any).UniqueDeviceID ?? (d as any).SerialNumber ?? ""), name: String((d as any).DeviceName ?? "iPhone") }))
      .filter((d) => d.udid && !seen.has(d.udid) && seen.add(d.udid));
  } catch {
    return [];
  }
}

/** The tool's last meaningful lines, for saying what went wrong. */
export const lastLines = (out: string, n = 3) => out.replace(/\x1b\[[0-9;]*m/g, "").split(/\r?\n/).map((l) => l.trim()).filter(Boolean).slice(-n).join(" | ").slice(0, 400);

export class LivePhoneBackup implements PhoneBackup {
  readonly kind = "pymobiledevice3" as const;
  private dir: string;
  private py: string;
  constructor(private cfg: Config) {
    this.dir = path.join(cfg.stateDir, "iphone-tools");
    this.py = path.join(this.dir, process.platform === "win32" ? "Scripts\\python.exe" : "bin/python");
  }

  async ready(): Promise<string | null> {
    if (existsSync(this.py) && (await run(this.py, ["-m", "pymobiledevice3", "version"], 60_000)).code === 0) return null;
    mkdirSync(this.cfg.stateDir, { recursive: true });
    const [cmd, ...pre] = this.cfg.python.split(" ");
    const venv = await run(cmd, [...pre, "-m", "venv", this.dir], 5 * 60_000);
    if (venv.code !== 0 || !existsSync(this.py)) return `Couldn't set up Python for the iPhone tool (${lastLines(venv.out)}).`;
    const pip = await run(this.py, ["-m", "pip", "install", "--quiet", "--disable-pip-version-check", "pymobiledevice3"], 15 * 60_000);
    if (pip.code !== 0) return `Couldn't install the iPhone tool (${lastLines(pip.out)}).`;
    return null;
  }

  async devices(): Promise<PhoneDevice[]> {
    const r = await run(this.py, ["-m", "pymobiledevice3", "usbmux", "list", "--usb"], 60_000);
    return r.code === 0 ? parseDevices(r.out) : [];
  }

  async backup(udid: string, root: string): Promise<void> {
    mkdirSync(root, { recursive: true });
    const r = await run(this.py, ["-m", "pymobiledevice3", "backup2", "backup", "--udid", udid, root], 3 * 60 * 60_000);
    if (r.code !== 0) throw new Error(lastLines(r.out) || `the tool stopped with code ${r.code}`);
  }
}

/** For tests: pretends a phone is (or isn't) plugged in and remembers what it was asked to back up. */
export class MockPhoneBackup implements PhoneBackup {
  readonly kind = "mock" as const;
  backups: { udid: string; root: string }[] = [];
  problem: string | null = null;
  fail: string | null = null;
  constructor(public plugged: PhoneDevice[] = [], private onBackup?: (udid: string, root: string) => void) {}
  async ready() { return this.problem; }
  async devices() { return this.plugged; }
  async backup(udid: string, root: string) {
    if (this.fail) throw new Error(this.fail);
    this.backups.push({ udid, root });
    this.onBackup?.(udid, root);
  }
}

export function makePhoneBackup(cfg: Config): PhoneBackup | null {
  return cfg.mode === "live" && cfg.texts.enabled && cfg.texts.autoBackup ? new LivePhoneBackup(cfg) : null;
}
