/**
 * The helper the Claude desktop app starts to reach Keystone (a "local MCP server"). Plain JavaScript with nothing
 * to install, so it runs on the Node that ships inside the Claude app (it is packed into "Keystone for Claude.mcpb"
 * and is also what Connect Claude app points the app at). It holds no logic and no
 * keys: it speaks the Model Context Protocol on stdin/stdout and passes each request to the Keystone that's
 * already running on this computer (http://127.0.0.1:4317). If Keystone isn't open, it says so.
 * Nothing but protocol messages may be written to stdout.
 */
const { createInterface } = require("node:readline");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

// A small log, so a connection that doesn't work can be looked at: %TEMP%\keystone-claude-helper.log
const LOG = path.join(os.tmpdir(), "keystone-claude-helper.log");
function log(line) {
  try {
    if (fs.existsSync(LOG) && fs.statSync(LOG).size > 200000) fs.writeFileSync(LOG, "");
    fs.appendFileSync(LOG, `${new Date().toISOString()} ${line}\n`);
  } catch { /* logging is best effort */ }
  try { process.stderr.write(`[keystone] ${line}\n`); } catch { /* same */ }
}

// (Anything that isn't a web address, such as an unfilled setting, falls back to Keystone's usual place.)
const base = () => (/^https?:\/\//.test(process.env.KEYSTONE_URL || "") ? process.env.KEYSTONE_URL : "http://127.0.0.1:4317").replace(/\/$/, "");
// A Claude Code session in the cloud (started from claude.ai or the phone) runs on Anthropic's computers, not Hunter's
// PC, so it can never reach Keystone at 127.0.0.1: say that plainly instead of "Keystone isn't open".
const CLOUD = process.env.CLAUDE_CODE_REMOTE === "true" || !!process.env.CLAUDE_CODE_REMOTE_SESSION_ID;
const NOT_RUNNING = CLOUD
  ? "This Claude session runs in the cloud, not on Hunter's PC, so it can't reach Keystone (Keystone only answers on the PC itself). Nothing is broken. To work with Keystone: use the Claude desktop app on the PC (the Keystone extension), or open a Claude Code session on the PC in the forefront-hub folder, or use the Estimator's \"Send to Claude chat\" hand-off through Google Drive. Do not invent Keystone data."
  : "Keystone isn't open on this computer. Start it from the desktop icon (Start Keystone), wait for it to finish loading, then try again.";

const send = (m) => process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", ...m })}\n`);

async function keystone(pathname, body) {
  const r = await fetch(`${base()}${pathname}`, body === undefined ? {} : { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(j.error || `Keystone answered ${r.status}`);
  return j;
}

async function handle(m) {
  const reply = (result) => ({ id: m.id, result });
  switch (m.method) {
    case "initialize": {
      // Keystone's own instructions when it's open; a plain note when it isn't, so the app still connects.
      const info = await keystone("/api/claude-bridge/tools").catch(() => null);
      return reply({ protocolVersion: m.params?.protocolVersion || "2025-06-18", capabilities: { tools: {} }, serverInfo: { name: "keystone", title: "Keystone", version: "1.0.0" }, instructions: info?.instructions ?? NOT_RUNNING });
    }
    case "ping":
      return reply({});
    case "tools/list":
      try {
        return reply({ tools: (await keystone("/api/claude-bridge/tools")).tools });
      } catch {
        // Keystone is closed: one tool that explains, so Claude can tell Hunter what to do.
        return reply({ tools: [{ name: "keystone_status", description: "Keystone isn't open on this computer right now. Call this to check again.", inputSchema: { type: "object", properties: {} } }] });
      }
    case "tools/call":
      try {
        if (m.params?.name === "keystone_status") {
          const ok = await keystone("/api/claude-bridge/tools").then(() => true).catch(() => false);
          return reply({ content: [{ type: "text", text: ok ? "Keystone is open now. Ask Hunter to start a new chat (or reconnect Keystone in the Claude app) so its tools load." : NOT_RUNNING }], isError: !ok });
        }
        return reply(await keystone("/api/claude-bridge/call", { name: m.params?.name, arguments: m.params?.arguments ?? {} }));
      } catch (e) {
        const msg = e.message;
        return reply({ content: [{ type: "text", text: /fetch failed|ECONNREFUSED/i.test(msg) ? NOT_RUNNING : `Keystone couldn't do that: ${msg}` }], isError: true });
      }
    case "resources/list":
      return reply({ resources: [] });
    case "prompts/list":
      return reply({ prompts: [] });
    default:
      // Notifications (no id) need no answer; an unknown request gets the protocol's "method not found".
      return m.id === undefined || m.id === null ? null : { id: m.id, error: { code: -32601, message: `Method not found: ${m.method}` } };
  }
}

module.exports = { handle };

// Always serve when started as a program, however the Claude app launches it (it doesn't always run the file the
// way a terminal would). Only a test that loads this file for `handle` turns it off.
if (process.env.KEYSTONE_HELPER_TEST !== "1") {
  log(`started (node ${process.version}, ${process.platform}); Keystone at ${base()}`);
  process.on("uncaughtException", (e) => log(`error: ${e && e.stack ? e.stack : e}`));
  process.on("unhandledRejection", (e) => log(`error: ${e && e.stack ? e.stack : e}`));
  const rl = createInterface({ input: process.stdin });
  // One request at a time, answered in the order they arrived.
  let queue = Promise.resolve();
  rl.on("line", (line) => { queue = queue.then(() => answer(line)).catch((e) => log(`error: ${e && e.message}`)); });
  const answer = async (line) => {
    if (!line.trim()) return;
    let m;
    try { m = JSON.parse(line); } catch { return send({ id: null, error: { code: -32700, message: "Parse error" } }); }
    if (m.method && m.method !== "ping") log(`request: ${m.method}${m.params && m.params.name ? ` ${m.params.name}` : ""}`);
    const out = await handle(m).catch((e) => (m.id === undefined ? null : { id: m.id, error: { code: -32603, message: e.message } }));
    if (out) send(out);
  };
  rl.on("close", () => { log("stopped (the Claude app closed the connection)"); process.exit(0); });
}
