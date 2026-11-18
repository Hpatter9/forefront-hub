/**
 * The helper the Claude desktop app starts to reach Keystone (a "local MCP server"). It holds no logic and no
 * keys: it speaks the Model Context Protocol on stdin/stdout and passes each request to the Keystone that's
 * already running on this computer (http://127.0.0.1:4317). If Keystone isn't open, it says so.
 * Nothing but protocol messages may be written to stdout.
 */
import { createInterface } from "node:readline";

const base = () => (process.env.KEYSTONE_URL || "http://127.0.0.1:4317").replace(/\/$/, "");
const NOT_RUNNING = "Keystone isn't open on this computer. Start it from the desktop icon (Start Keystone), wait for it to finish loading, then try again.";

type Rpc = { jsonrpc: "2.0"; id?: number | string | null; method?: string; params?: any };
const send = (m: object) => process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", ...m })}\n`);

async function keystone(pathname: string, body?: unknown): Promise<any> {
  const r = await fetch(`${base()}${pathname}`, body === undefined ? {} : { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  const j: any = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(j.error || `Keystone answered ${r.status}`);
  return j;
}

export async function handle(m: Rpc): Promise<object | null> {
  const reply = (result: unknown) => ({ id: m.id, result });
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
        const msg = (e as Error).message;
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

/** Runs when started by the Claude app (not when a test imports `handle`). */
if (process.argv[1] && /stdio\.(ts|js|mjs)$/.test(process.argv[1])) {
  const rl = createInterface({ input: process.stdin });
  rl.on("line", async (line) => {
    if (!line.trim()) return;
    let m: Rpc;
    try { m = JSON.parse(line); } catch { return send({ id: null, error: { code: -32700, message: "Parse error" } }); }
    const out = await handle(m).catch((e) => (m.id === undefined ? null : { id: m.id, error: { code: -32603, message: (e as Error).message } }));
    if (out) send(out);
  });
  rl.on("close", () => process.exit(0));
}
