import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { addKeystoneToClaudeApp, claudeAppConfigFiles } from "../src/cli/connect.js";
import { createRequire } from "node:module";
import { unzip } from "../src/core/zip.js";
import { bridge } from "../src/server/claudeBridge.js";
import { MockGmail } from "../src/connectors/gmail/mock.js";
import { ESTIMATOR_DIR, testHub } from "./helpers.js";

function setup() {
  const t = testHub(false); // Keystone's own yes/no would say no: the bridge must not need it
  t.hub.cfg.skillDir = path.join(ESTIMATOR_DIR, "skill", "forefront-estimate");
  t.hub.cfg.hubRoot = process.cwd();
  t.hub.jobs.upsert(9001, { name: "Sample", address: "123 Main St, Denver, CO 80211" });
  const put = (rel: string, text: string) => { const f = path.join(t.hub.jobs.folder(9001), rel); mkdirSync(path.dirname(f), { recursive: true }); writeFileSync(f, text); };
  return { ...t, put, br: bridge(t.hub) };
}
const textOf = (r: { content: any[] }) => r.content.filter((c) => c.type === "text").map((c) => c.text).join("\n");

describe("Keystone's tools for the Claude app (estimates on the subscription)", () => {
  it("starts an estimate with how to work, the skill's own instructions and everything on the job", async () => {
    const { br, put, hub } = setup();
    put("notes/notes.txt", "Lockbox on the side gate.");
    const names = br.list().map((t) => t.name);
    expect(names).toEqual(expect.arrayContaining(["keystone_find_job", "keystone_start_estimate", "keystone_run_script", "keystone_write_file", "keystone_view_photos", "keystone_check_estimate"]));
    expect(names.some((n) => /send|stage|calendar|homebase/.test(n))).toBe(false); // estimating, plus Gmail drafts
    expect(names).toContain("keystone_create_draft");
    const start = textOf(await br.call("keystone_start_estimate", { jobNumber: 9001 }));
    expect(start).toContain("call keystone_run_script");
    expect(start).toContain(readFileSync(path.join(hub.cfg.skillDir, "SKILL.md"), "utf8").slice(0, 300));
    expect(start).toContain("Lockbox on the side gate.");
    expect(textOf(await br.call("keystone_find_job", { query: "sample" }))).toContain('"jobNumber":9001');
  });

  it("runs the skill's scripts and writes into the job folder, keeping the old estimate, without Keystone's own card", async () => {
    const { br, hub } = setup();
    expect(textOf(await br.call("keystone_run_script", { jobNumber: 9001, script: "price_lookup.py", args: ["baseboard"] }))).toMatch(/baseboard/i);
    expect(textOf(await br.call("keystone_run_script", { jobNumber: 9001, script: "format_disk.py", args: [] }))).toMatch(/Only these scripts/);
    await br.call("keystone_write_file", { jobNumber: 9001, path: "estimate/estimate.json", content: "{\"v\":1}" });
    expect(textOf(await br.call("keystone_write_file", { jobNumber: 9001, path: "estimate/estimate.json", content: "{\"v\":2}" }))).toMatch(/Wrote estimate\/estimate.json/);
    expect(readFileSync(path.join(hub.jobs.folder(9001), "estimate", "revisions", "v1", "estimate.json"), "utf8")).toBe("{\"v\":1}");
    expect(textOf(await br.call("keystone_write_file", { jobNumber: 9001, path: "../../outside.txt", content: "x" }))).toMatch(/only be written inside this job/);
    expect(textOf(await br.call("keystone_read_file", { jobNumber: 9001, path: "/etc/passwd" }))).toMatch(/Only this job's folder/);
    expect(textOf(await br.call("keystone_pdf_text", { jobNumber: 9001, path: "../../x.pdf" }))).toMatch(/Only files in this job's folder/);
    expect(textOf(await br.call("keystone_check_estimate", { jobNumber: 9001 }))).toMatch(/Keystone's check/);
    expect((await br.call("keystone_nope", {})).isError).toBe(true);
  });

  it("shows photos to Claude as images", async () => {
    const { br, put } = setup();
    put("photos/a.png", "png-bytes");
    const r = await br.call("keystone_view_photos", { jobNumber: 9001, paths: ["photos/a.png", "files/x.pdf"] });
    expect(r.content.find((c) => c.type === "image")).toEqual({ type: "image", mimeType: "image/png", data: Buffer.from("png-bytes").toString("base64") });
  });
});

describe("the helper the Claude app starts", () => {
  it("speaks the protocol and explains itself when Keystone isn't open", async () => {
    process.env.KEYSTONE_URL = "http://127.0.0.1:9"; // nothing listens here
    process.env.KEYSTONE_HELPER_TEST = "1"; // load it for `handle` without it starting to serve
    const h = createRequire(import.meta.url)("../mcpb/server/index.cjs").handle;
    const init: any = await h({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18" } });
    expect(init.result).toMatchObject({ protocolVersion: "2025-06-18", capabilities: { tools: {} }, serverInfo: { name: "keystone" } });
    expect(init.result.instructions).toMatch(/Keystone isn't open/);
    const list: any = await h({ jsonrpc: "2.0", id: 2, method: "tools/list" });
    expect(list.result.tools.map((t: any) => t.name)).toEqual(["keystone_status"]);
    const call: any = await h({ jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "keystone_start_estimate", arguments: { jobNumber: 1 } } });
    expect(call.result).toMatchObject({ isError: true });
    expect(call.result.content[0].text).toMatch(/Start it from the desktop icon/);
    expect(await h({ jsonrpc: "2.0", method: "notifications/initialized" })).toBeNull();
    expect(((await h({ jsonrpc: "2.0", id: 4, method: "nope" })) as any).error.code).toBe(-32601);
    delete process.env.KEYSTONE_URL;
  });
});

describe("Connect Claude app", () => {
  it("adds Keystone to the Claude app's settings without touching what's already there", () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "claude-cfg-"));
    const file = path.join(dir, "Claude", "claude_desktop_config.json");
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, JSON.stringify({ theme: "dark", mcpServers: { other: { command: "x" } } }));
    expect(addKeystoneToClaudeApp(file, "C:\\Games\\forefront-hub", 4317, "C:\\node\\node.exe")).toMatchObject({ added: true });
    const cfg = JSON.parse(readFileSync(file, "utf8"));
    expect(cfg.theme).toBe("dark");
    expect(cfg.mcpServers.other).toEqual({ command: "x" });
    expect(cfg.mcpServers.keystone.command).toBe("C:\\node\\node.exe");
    expect(cfg.mcpServers.keystone.args).toHaveLength(1);
    expect(cfg.mcpServers.keystone.args[0]).toMatch(/mcpb.server.index\.cjs$/);
    expect(cfg.mcpServers.keystone.env).toEqual({ KEYSTONE_URL: "http://127.0.0.1:4317" });
    expect(existsSync(`${file}.before-keystone`)).toBe(true);
    expect(addKeystoneToClaudeApp(file, "C:\\Games\\forefront-hub", 4317, "C:\\node\\node.exe").added).toBe(false);
    writeFileSync(file, "{ not json");
    expect(() => addKeystoneToClaudeApp(file, "x", 4317)).toThrow(/isn't valid JSON/);
    expect(claudeAppConfigFiles({ APPDATA: "C:\\Users\\h\\AppData\\Roaming" }, "win32")[0]).toMatch(/Claude.claude_desktop_config\.json$/);
  });
});

describe("the extension file for the Claude app", () => {
  it("is packed from the current helper and manifest, and says how to start it", () => {
    const zip = unzip(readFileSync("Keystone for Claude.mcpb"));
    expect([...zip.keys()].sort()).toEqual(["manifest.json", "server/index.cjs"]);
    expect(zip.get("server/index.cjs")!.toString()).toBe(readFileSync("mcpb/server/index.cjs", "utf8")); // rebuild with scripts/build-mcpb.py after changing it
    expect(zip.get("manifest.json")!.toString()).toBe(readFileSync("mcpb/manifest.json", "utf8"));
    const m = JSON.parse(zip.get("manifest.json")!.toString());
    expect(m).toMatchObject({ manifest_version: "0.3", name: "keystone", author: { name: expect.any(String) }, server: { type: "node", entry_point: "server/index.cjs", mcp_config: { command: "node", args: ["${__dirname}/server/index.cjs"] } } });
    expect(m.version && m.description).toBeTruthy();
  });

  it("finds the Microsoft Store version's settings first, where the ordinary settings file is ignored", () => {
    const base = mkdtempSync(path.join(os.tmpdir(), "claude-store-"));
    mkdirSync(path.join(base, "Local", "Packages", "Claude_pzs8sxrjxfjjc"), { recursive: true });
    const files = claudeAppConfigFiles({ APPDATA: path.join(base, "Roaming"), LOCALAPPDATA: path.join(base, "Local") }, "win32");
    expect(files[0]).toBe(path.join(base, "Local", "Packages", "Claude_pzs8sxrjxfjjc", "LocalCache", "Roaming", "Claude", "claude_desktop_config.json"));
    expect(files[1]).toBe(path.join(base, "Roaming", "Claude", "claude_desktop_config.json"));
  });

  it("makes the send-off as a Gmail draft with the PDFs attached and the Homebase log BCC'd (never sent)", async () => {
    const { br, put, hub } = setup();
    put("estimate/Sample - Reconstruction Estimate.pdf", "%PDF-1.4 test");
    const r = textOf(await br.call("keystone_create_draft", { jobNumber: 9001, kind: "homeowner", to: ["dana@example.com"], subject: "Sample - Reconstruction Estimate", body: "Hi Dana,\n\nAttached.", attachments: ["estimate/Sample - Reconstruction Estimate.pdf"] }));
    expect(r).not.toMatch(/Error/);
    const d = (hub.gmail as MockGmail).drafts().find((x) => x.input.subject === "Sample - Reconstruction Estimate")!;
    expect(d.input.bcc).toContain("office+9001@forefrontteam.com");
    expect(d.input.attachments[0]).toBe(path.join(hub.jobs.folder(9001), "estimate", "Sample - Reconstruction Estimate.pdf"));
  });
});
