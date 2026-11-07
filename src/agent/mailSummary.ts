import { query } from "@anthropic-ai/claude-agent-sdk";
import { claudeEnv } from "./env.js";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { Hub } from "../hub.js";

/**
 * One line, 10 words or less, saying what a conversation is about, for the Gmail tab's list ("Adjuster wants
 * hallway flooring photos before approving LVP"). Claude writes them in batches with the fast model; each is kept
 * until the thread changes (its historyId moves), so a thread is summarized once per new message.
 */
interface Entry {
  h: string;
  s: string;
}
const file = (hub: Hub) => path.join(hub.cfg.stateDir, "mail-summaries.json");
let cache: Record<string, Entry> | null = null;
function load(hub: Hub) {
  if (cache) return cache;
  try {
    cache = existsSync(file(hub)) ? JSON.parse(readFileSync(file(hub), "utf8")) : {};
  } catch {
    cache = {};
  }
  return cache!;
}
function save(hub: Hub) {
  mkdirSync(hub.cfg.stateDir, { recursive: true });
  const c = load(hub);
  const keys = Object.keys(c);
  if (keys.length > 3000) for (const k of keys.slice(0, keys.length - 3000)) delete c[k];
  writeFileSync(file(hub), JSON.stringify(c));
}

export const enabled = (hub: Hub) => !!hub.cfg.anthropicApiKey && (process.env.HUB_MAIL_SUMMARIES ?? "on") !== "off";

/** Summaries already written for these threads (only those still current). */
export function summariesFor(hub: Hub, threads: { id: string; historyId?: string }[]): Record<string, string> {
  const c = load(hub);
  const out: Record<string, string> = {};
  for (const t of threads) {
    const e = c[t.id];
    if (e && (!t.historyId || e.h === t.historyId)) out[t.id] = e.s;
  }
  return out;
}

const SCHEMA = {
  type: "object",
  properties: { items: { type: "array", items: { type: "object", properties: { n: { type: "integer" }, summary: { type: "string" } }, required: ["n", "summary"], additionalProperties: false } } },
  required: ["items"],
  additionalProperties: false,
};

let running: Promise<number> | null = null;
const queue = new Map<string, { id: string; historyId?: string; sent?: boolean }>();

/** Queues threads for a summary and works through them in the background. Calls `done` after each batch. */
export function requestSummaries(hub: Hub, threads: { id: string; historyId?: string; sent?: boolean }[], done: (n: number) => void) {
  if (!enabled(hub)) return;
  const have = summariesFor(hub, threads);
  for (const t of threads) if (!have[t.id]) queue.set(t.id, t);
  if (running || !queue.size) return;
  running = (async () => {
    let total = 0;
    try {
      while (queue.size) {
        const batch = [...queue.values()].slice(0, 15);
        for (const t of batch) queue.delete(t.id);
        const n = await summarizeBatch(hub, batch).catch((e) => (console.error("mail summaries:", (e as Error).message), 0));
        total += n;
        if (n) done(n);
        if (!n) break; // don't spin on a failing batch; the next list load tries again
      }
    } finally {
      running = null;
    }
    return total;
  })();
}

async function summarizeBatch(hub: Hub, batch: { id: string; historyId?: string; sent?: boolean }[]): Promise<number> {
  const me = hub.cfg.gmail.address.toLowerCase();
  const items: { t: (typeof batch)[number]; text: string }[] = [];
  for (const t of batch) {
    const th = await hub.gmail.getThread(t.id, t.historyId).catch(() => null);
    const last = th?.messages.at(-1);
    if (!th || !last) continue;
    const fromMe = last.from.toLowerCase().includes(me);
    const body = last.body.replace(/\r/g, "").split(/\n(?:On .+wrote:|-{2,}\s*(?:Original|Forwarded) Message)/)[0].replace(/\s+/g, " ").trim().slice(0, 1200);
    items.push({ t, text: `Subject: ${last.subject}\nFrom: ${fromMe ? "Hunter (me)" : last.from}\nTo: ${last.to.join(", ")}\n${th.messages.length > 1 ? `(${th.messages.length} messages in the conversation; this is the latest)\n` : ""}${body}` });
  }
  if (!items.length) return 0;
  const prompt = `Hunter Patterson is an estimator at Forefront Building + Restoration (Colorado reconstruction after water/fire damage). For each email below, write ONE line of 10 words or fewer that tells him what it is at a glance: what it's about and what it asks or says. Plain and specific, no quotes, no trailing period, don't start with "Email" or the sender's name. Use the job or street when it helps. If Hunter wrote it, say what he sent or asked ("Sent Wegener the revised estimate and Xactimate"). Newsletters, receipts and notifications get a short label ("QuickBooks receipt for Home Depot order").

${items.map((x, i) => `#${i + 1}\n${x.text}`).join("\n\n---\n\n")}`;
  let out: { n: number; summary: string }[] = [];
  for await (const m of query({
    prompt,
    options: {
      model: hub.cfg.fastModel,
      maxTurns: 2,
      allowedTools: [],
      settingSources: [],
      outputFormat: { type: "json_schema", schema: SCHEMA },
      canUseTool: async () => ({ behavior: "deny", message: "No tools needed." }),
      systemPrompt: "You write very short, specific one-line email summaries.",
      env: claudeEnv(hub),
    },
  })) {
    if (m.type === "result" && m.subtype === "success") {
      const so = (m as any).structured_output ?? JSON.parse(m.result.match(/\{[\s\S]*\}/)?.[0] ?? '{"items":[]}');
      out = so.items ?? [];
    }
  }
  const c = load(hub);
  let n = 0;
  for (const r of out) {
    const x = items[r.n - 1];
    const s = shorten(r.summary);
    if (!x || !s) continue;
    c[x.t.id] = { h: x.t.historyId ?? "", s };
    n++;
  }
  if (n) save(hub);
  return n;
}

/** Keeps a summary to one line of at most 10 words. */
export function shorten(s: string): string {
  const w = String(s ?? "").replace(/\s+/g, " ").trim().replace(/^["'“]+|["'”.]+$/g, "").trim().split(" ").filter(Boolean);
  return w.slice(0, 10).join(" ");
}
