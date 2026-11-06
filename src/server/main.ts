#!/usr/bin/env node
import { createReadStream, existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import http, { type IncomingMessage, type ServerResponse } from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadConfig } from "../core/config.js";
import { describe, makeHub, type Hub } from "../hub.js";
import { MockGmail } from "../connectors/gmail/mock.js";
import { downloadPhotos, pullJob } from "../workflows/pull.js";
import { estimateFiles, sendoff } from "../workflows/sendoff.js";
import { sync } from "../workflows/sync.js";
import { syncFiles, uploadToHomebase } from "../workflows/files.js";
import { syncAll, type SyncAllResult } from "../workflows/background.js";
import { TemplateWriter, type Recipient } from "../workflows/writer.js";
import { EventBus, WebApprover } from "./events.js";

/**
 * The hub's screen: a local web app on 127.0.0.1. The same server is what the desktop (Electron) window will load.
 * Every action runs the same workflows as the CLI; anything irreversible asks in the browser first.
 */
const HERE = path.dirname(fileURLToPath(import.meta.url));
const cfg = loadConfig();
const bus = new EventBus();
const approver = new WebApprover(bus);
const hub: Hub = makeHub(cfg, approver);
let currentJob: number | undefined;
hub.say = (text) => {
  console.log(text);
  bus.emit({ type: "log", text, job: currentJob });
};

const MIME: Record<string, string> = { ".pdf": "application/pdf", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".png": "image/png", ".json": "application/json", ".txt": "text/plain; charset=utf-8", ".eml": "message/rfc822", ".html": "text/html; charset=utf-8" };

function send(res: ServerResponse, status: number, body: unknown) {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(body));
}

async function body(req: IncomingMessage): Promise<any> {
  let s = "";
  for await (const c of req) s += c;
  return s ? JSON.parse(s) : {};
}

/** Runs a workflow in the background; progress and approvals stream to the page. */
function task(label: string, job: number | undefined, fn: () => Promise<unknown>) {
  const id = crypto.randomUUID();
  bus.emit({ type: "task", id, state: "running", label, job });
  currentJob = job;
  fn()
    .then(() => bus.emit({ type: "task", id, state: "done", label, job }))
    .catch((e) => {
      console.error(e);
      bus.emit({ type: "task", id, state: "error", label, job, error: (e as Error).message });
    })
    .finally(() => {
      currentJob = undefined;
      void hub.homebase.close?.();
    });
  return { taskId: id };
}

function listDir(dir: string) {
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f) => statSync(path.join(dir, f)).isFile())
    .map((f) => ({ name: f, size: statSync(path.join(dir, f)).size, modified: statSync(path.join(dir, f)).mtime.toISOString() }))
    .sort((a, b) => b.modified.localeCompare(a.modified));
}

function inside(file: string, dir: string) {
  const rel = path.relative(path.resolve(dir), path.resolve(file));
  return !!rel && !rel.startsWith("..") && !path.isAbsolute(rel);
}

async function jobView(n: number) {
  const [hb, emails, activity] = await Promise.all([
    hub.homebase.getJob(n),
    hub.homebase.emails?.(n).catch(() => []) ?? Promise.resolve([]),
    hub.homebase.activity?.(n).catch(() => []) ?? Promise.resolve([]),
  ]);
  const local = hub.jobs.exists(n) ? hub.jobs.get(n) : null;
  const files = local
    ? Object.fromEntries((["estimate", "sketch", "email", "notes"] as const).map((s) => [s, listDir(hub.jobs.path(n, s))]))
    : {};
  const photos = local ? listDir(hub.jobs.path(n, "photos")).filter((f) => /\.(jpe?g|png)$/i.test(f.name)) : [];
  const est = local ? estimateFiles(hub, n) : null;
  // Files: mirror Homebase's Documents tab into the folder (cheap when nothing changed), else just list it.
  let hbFiles: { docs: any[]; toUpload: { name: string; kind: string }[] } = { docs: [], toUpload: [] };
  try {
    if (local) {
      const r = await syncFiles(hub, n);
      hbFiles = { docs: r.docs, toUpload: r.toUpload.map((f) => ({ name: f.name, kind: f.kind })) };
    } else if (hub.homebase.documents) hbFiles = { docs: await hub.homebase.documents(n), toUpload: [] };
  } catch (e) {
    console.error(e);
  }
  return {
    hbFiles,
    homebase: { ...hb, text: undefined },
    local,
    folder: local ? hub.jobs.folder(n) : hub.jobs.folder(n, hb.name),
    files,
    photos,
    hasEstimate: !!est?.estimateJson,
    emails,
    activity,
  };
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url ?? "/", "http://localhost");
  const p = url.pathname;
  try {
    if (p === "/" || p === "/index.html") {
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" });
      return res.end(readFileSync(path.join(HERE, "ui.html")));
    }
    if (p === "/api/events") return bus.attach(res);
    if (p === "/api/status") {
      return send(res, 200, {
        lines: describe(hub),
        homebase: hub.homebase.kind,
        gmail: hub.gmail.kind,
        companycam: hub.photos.kind,
        agent: !!cfg.anthropicApiKey,
        me: cfg.homebase.me,
        jobsRoot: cfg.jobsRoot,
      });
    }
    if (p === "/api/jobs" && req.method === "GET") {
      const jobs = await hub.homebase.listJobs({ openOnly: url.searchParams.get("all") !== "1", details: true, mine: url.searchParams.get("mine") === "1" ? cfg.homebase.me : undefined });
      const local = new Map(hub.jobs.list().map((j) => [j.jobNumber, j]));
      const ready = new Set(lastSync?.readyToLog ?? []);
      const upload = new Set((lastSync?.needsUpload ?? []).map((x) => x.jobNumber));
      return send(res, 200, jobs.map((j) => ({ ...j, readyToLog: ready.has(j.jobNumber), needsUpload: upload.has(j.jobNumber), local: local.has(j.jobNumber) ? { estimate: local.get(j.jobNumber)!.estimate.status, drafts: local.get(j.jobNumber)!.sendoff.drafts.length } : null })));
    }
    const m = p.match(/^\/api\/jobs\/(\d+)(?:\/(.+))?$/);
    if (m) {
      const n = Number(m[1]);
      const action = m[2] ?? "";
      if (req.method === "GET" && action === "") return send(res, 200, await jobView(n));
      if (req.method === "GET" && action.startsWith("file/")) {
        const file = path.join(hub.jobs.folder(n), decodeURIComponent(action.slice(5)));
        if (!inside(file, hub.jobs.folder(n)) || !existsSync(file)) return send(res, 404, { error: "not found" });
        res.writeHead(200, { "Content-Type": MIME[path.extname(file).toLowerCase()] ?? "application/octet-stream", "Content-Disposition": `inline; filename="${path.basename(file)}"` });
        return createReadStream(file).pipe(res);
      }
      const doc = action.match(/^hbdoc\/([\w-]+)$/);
      if (req.method === "GET" && doc) {
        // A Homebase document: the job folder's copy when there is one, else fetched for this view.
        const docs = (await hub.homebase.documents?.(n)) ?? [];
        const d = docs.find((x) => x.id === doc[1]);
        if (!d || !hub.homebase.downloadDocument) return send(res, 404, { error: "not found" });
        const tmp = path.join(cfg.stateDir, "hbdocs", d.id);
        if (!existsSync(tmp)) await hub.homebase.downloadDocument(d, tmp);
        res.writeHead(200, { "Content-Type": d.mimeType || "application/octet-stream", "Content-Disposition": `inline; filename="${d.fileName.replace(/"/g, "")}"` });
        return createReadStream(tmp).pipe(res);
      }
      if (req.method !== "POST") return send(res, 405, { error: "method" });
      const b = await body(req);
      switch (action) {
        case "pull":
          return send(res, 202, task(`Pull #${n} from Homebase`, n, () => pullJob(hub, n)));
        case "photos":
          return send(res, 202, task(`Download CompanyCam photos for #${n}`, n, () => downloadPhotos(hub, n)));
        case "set": {
          const cur = hub.jobs.exists(n) ? hub.jobs.get(n) : await pullJob(hub, n);
          const job = hub.jobs.upsert(n, {
            customer: { name: b.customerName || undefined, email: b.customerEmail || undefined },
            adjuster: { name: b.adjusterName || undefined, email: b.adjusterEmail || undefined, phone: b.adjusterPhone || undefined },
            claimNumber: b.claimNumber || undefined,
            carrier: b.carrier || undefined,
            insurance: b.insurance || undefined,
            estimate: b.total ? { ...cur.estimate, total: Number(b.total) } : undefined,
          });
          return send(res, 200, job);
        }
        case "sendoff": {
          const to: Recipient[] = b.to?.length ? b.to : ["homeowner"];
          return send(res, 202, task(`Draft send-off for #${n} (${to.join(" + ")})`, n, async () => {
            if (!hub.jobs.exists(n)) await pullJob(hub, n);
            const useTemplate = b.template || cfg.mode === "mock" || !cfg.anthropicApiKey;
            const writer = useTemplate ? new TemplateWriter() : new (await import("../agent/writer.js")).AgentWriter(hub);
            if (useTemplate) hub.say("Using plain template wording (no Claude API key on this machine).");
            await sendoff(hub, n, { to, writer, cc: b.cc ? String(b.cc).split(",").map((s: string) => s.trim()) : undefined });
          }));
        }
        case "sync":
          return send(res, 202, task(`Check sent emails for #${n}`, n, async () => {
            const r = await sync(hub, n);
            hub.say(r.length ? r.map((x) => `#${x.jobNumber}: ${x.sent.length ? `sent ${x.sent.join(", ")}; ` : ""}${x.logged ? "logged in Homebase" : "not logged yet"}${x.note ? ` (${x.note})` : ""}`).join("\n") : "No send-off drafts on this job yet.");
          }));
        case "log":
          return send(res, 202, task(`Log ${b.kind} on #${n}`, n, async () => {
            if (!(await approver.confirm(`Add this ${b.kind} to Homebase #${n}?`, [b.body, b.who ? `with ${b.who}` : ""].filter(Boolean)))) return hub.say("Not logged.");
            await hub.homebase.addNote(n, { kind: b.kind, body: b.body, who: b.who || undefined, direction: b.direction });
            if (hub.jobs.exists(n)) hub.jobs.log(n, `Homebase ${b.kind}: ${String(b.body).slice(0, 80)}`);
            hub.say(`Logged the ${b.kind} on Homebase #${n}.`);
          }));
        case "files-sync":
          return send(res, 202, task(`Sync files with Homebase #${n}`, n, async () => {
            if (!hub.jobs.exists(n)) await pullJob(hub, n);
            const r = await syncFiles(hub, n);
            hub.say(`#${n}: ${r.docs.length} file${r.docs.length === 1 ? "" : "s"} in Homebase${r.downloaded.length ? `, downloaded ${r.downloaded.join(", ")}` : ", all already in the folder"}${r.toUpload.length ? `; not in Homebase yet: ${r.toUpload.map((f) => f.name).join(", ")}` : ""}.`);
          }));
        case "files-upload":
          return send(res, 202, task(`Upload files to Homebase #${n}`, n, () => uploadToHomebase(hub, n, b.names)));
        case "mock-send": {
          if (!(hub.gmail instanceof MockGmail)) return send(res, 400, { error: "Only with the mock Gmail" });
          for (const d of hub.jobs.get(n).sendoff.drafts) if (!d.sentAt) hub.gmail.markSent(d.id);
          return send(res, 200, { ok: true });
        }
        default:
          return send(res, 404, { error: `unknown action ${action}` });
      }
    }
    if (p === "/api/sync-all" && req.method === "POST") {
      return send(res, 202, runSyncAll());
    }
    if (p === "/api/sync-all" && req.method === "GET") return send(res, 200, { running: syncRunning, last: lastSync });
    if (p === "/api/ask" && req.method === "POST") {
      const b = await body(req);
      if (!cfg.anthropicApiKey) return send(res, 400, { error: "No Anthropic API key on this machine. Set ANTHROPIC_API_KEY in .env (or save it in the Estimator app)." });
      const job = b.job ? Number(b.job) : undefined;
      return send(res, 202, task(`Ask: ${String(b.prompt).slice(0, 60)}`, job, async () => {
        const { ask } = await import("../agent/run.js");
        await ask(hub, String(b.prompt), { jobNumber: job });
      }));
    }
    const a = p.match(/^\/api\/approvals\/([\w-]+)$/);
    if (a && req.method === "POST") {
      const b = await body(req);
      return send(res, approver.answer(a[1], !!b.yes) ? 200 : 404, { ok: true });
    }
    send(res, 404, { error: "not found" });
  } catch (e) {
    console.error(e);
    send(res, 500, { error: (e as Error).message });
  }
});

// ---- background sync: every 15 minutes while the hub is open (read-only toward Homebase and Gmail)
let lastSync: SyncAllResult | null = null;
let syncRunning = false;
function runSyncAll() {
  if (syncRunning) return { running: true };
  syncRunning = true;
  return task("Sync my jobs with Homebase", undefined, async () => {
    try {
      lastSync = await syncAll(hub);
      const s = lastSync;
      hub.say(
        `Synced ${s.jobs} jobs` +
          (s.newFolders.length ? `; new folders: ${s.newFolders.map((n) => `#${n}`).join(", ")}` : "") +
          (s.newFiles.length ? `; new files on ${s.newFiles.map((f) => `#${f.jobNumber} (${f.files.length})`).join(", ")}` : "") +
          (s.readyToLog.length ? `; sent and ready to log: ${s.readyToLog.map((n) => `#${n}`).join(", ")}` : "") +
          (s.errors.length ? `; ${s.errors.length} job(s) had errors: ${s.errors.map((e) => `#${e.jobNumber} ${e.error}`).join("; ")}` : "") +
          ".",
      );
    } finally {
      syncRunning = false;
    }
  });
}
const SYNC_MINUTES = Number(process.env.HUB_SYNC_MINUTES || 15);
if (SYNC_MINUTES > 0 && hub.homebase.kind !== "mock") {
  setTimeout(runSyncAll, 15_000);
  setInterval(runSyncAll, SYNC_MINUTES * 60_000);
}

const port = Number(process.env.HUB_PORT || 4317);
const host = process.env.HUB_HOST || "127.0.0.1";
server.listen(port, host, () => {
  console.log(`Forefront hub running at http://${host === "0.0.0.0" ? "localhost" : host}:${port}`);
  for (const l of describe(hub)) console.log(`  ${l}`);
});
