#!/usr/bin/env node
import { createReadStream, existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import http, { type IncomingMessage, type ServerResponse } from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadConfig } from "../core/config.js";
import { describe, makeHub, type Hub } from "../hub.js";
import { MockGmail } from "../connectors/gmail/mock.js";
import { intakeAddress } from "../connectors/homebase/types.js";
import { pullJob } from "../workflows/pull.js";
import { estimateFiles, sendoff } from "../workflows/sendoff.js";
import { sync } from "../workflows/sync.js";
import { syncFiles, uploadToHomebase } from "../workflows/files.js";
import { syncAll, type SyncAllResult } from "../workflows/background.js";
import { editContact, editFields, FIELDS, fieldValues, SECTIONS, setAdjuster } from "../workflows/fields.js";
import { timeline } from "../workflows/timeline.js";
import { REMINDER_GROUPS, reminders } from "../workflows/reminders.js";
import { STAGES } from "../core/job.js";
import { TemplateWriter, type Recipient } from "../workflows/writer.js";
import { autoFile, dismissUnfiled, fileMessage, inboxState } from "../workflows/inbox.js";
import { addFile } from "../workflows/uploads.js";
import { freeSlots } from "../connectors/calendar/index.js";
import { EventBus, WebApprover } from "./events.js";

/**
 * The hub's screen: a local web app on 127.0.0.1 (the desktop window will load the same thing). Every action runs the
 * same workflows as the CLI; anything that changes Homebase, sends an email or overwrites an estimate asks first.
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

const MIME: Record<string, string> = { ".pdf": "application/pdf", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".png": "image/png", ".json": "application/json", ".txt": "text/plain; charset=utf-8", ".eml": "message/rfc822", ".html": "text/html; charset=utf-8", ".esx": "application/octet-stream" };

function send(res: ServerResponse, status: number, body: unknown) {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(body));
}

async function rawBody(req: IncomingMessage, limit = 30 * 1024 * 1024): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let n = 0;
  for await (const c of req) {
    n += c.length;
    if (n > limit) throw new Error("That file is over 30 MB.");
    chunks.push(c as Buffer);
  }
  return Buffer.concat(chunks);
}

function listTree(dir: string, base = ""): { name: string; size: number; modified: string }[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir).flatMap((f) => {
    const full = path.join(dir, f);
    const rel = base ? `${base}/${f}` : f;
    return statSync(full).isDirectory() ? listTree(full, rel) : [{ name: rel, size: statSync(full).size, modified: statSync(full).mtime.toISOString() }];
  });
}

async function body(req: IncomingMessage): Promise<any> {
  let s = "";
  for await (const c of req) s += c;
  return s ? JSON.parse(s) : {};
}

/** Runs a workflow in the background; progress and approvals stream to the page. */
function task(label: string, job: number | undefined, fn: () => Promise<unknown>, after?: "timeline" | "mail" | "job") {
  const id = crypto.randomUUID();
  bus.emit({ type: "task", id, state: "running", label, job });
  currentJob = job;
  fn()
    .then(() => {
      bus.emit({ type: "task", id, state: "done", label, job });
      if (after) bus.emit({ type: "changed", job, what: after });
    })
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
    .filter((f) => statSync(path.join(dir, f)).isFile() && f !== "index.json")
    .map((f) => ({ name: f, size: statSync(path.join(dir, f)).size, modified: statSync(path.join(dir, f)).mtime.toISOString() }))
    .sort((a, b) => b.modified.localeCompare(a.modified));
}

function inside(file: string, dir: string) {
  const rel = path.relative(path.resolve(dir), path.resolve(file));
  return !!rel && !rel.startsWith("..") && !path.isAbsolute(rel);
}

async function noteAfter(n: number, kind: "email" | "call" | "send-off", text: string) {
  if (!cfg.anthropicApiKey) return;
  const { suggestNote } = await import("../agent/summarize.js");
  await suggestNote(hub, n, { kind, text });
  bus.emit({ type: "changed", job: n, what: "timeline" });
}

// ---------------------------------------------------------------- job page

async function jobView(n: number) {
  if (!hub.jobs.exists(n)) await pullJob(hub, n, { quiet: true, lookups: true });
  const [hb, raw] = await Promise.all([hub.homebase.getJob(n), hub.homebase.rawJob?.(n).catch(() => null) ?? Promise.resolve(null)]);
  const local = hub.jobs.get(n);
  let hbFiles: { docs: any[]; toUpload: { name: string; kind: string }[] } = { docs: [], toUpload: [] };
  try {
    const r = await syncFiles(hub, n);
    hbFiles = { docs: r.docs, toUpload: r.toUpload.map((f) => ({ name: f.name, kind: f.kind })) };
  } catch (e) {
    console.error(e);
  }
  const primary = (raw?.contacts ?? []).find((c: any) => c.isPrimary) ?? null;
  return {
    homebase: { ...hb, text: undefined },
    local,
    folder: hub.jobs.folder(n),
    projectName: raw?.name ?? "",
    fields: raw ? fieldValues(raw) : {},
    address: raw?.address ?? null,
    customer: primary ? { id: primary.id, name: primary.name, email: primary.email, phone: primary.phone ?? primary.mobile } : null,
    adjusters: [raw?.brief?.adjuster1 ?? null, raw?.brief?.adjuster2 ?? null],
    carrier: raw?.brief?.carrier ? { id: raw.brief.carrier.id, name: raw.brief.carrier.name } : null,
    files: {
      ...Object.fromEntries((["estimate", "sketch", "notes", "files"] as const).map((s) => [s, listDir(hub.jobs.path(n, s))])),
      attachments: listTree(hub.jobs.path(n, "email", "attachments")).sort((a, b) => b.name.localeCompare(a.name)),
      photosAdded: listDir(hub.jobs.path(n, "photos")).filter((f) => /\.(jpe?g|png|heic|webp|gif)$/i.test(f.name)),
    },
    hbFiles,
    hasEstimate: !!estimateFiles(hub, n).estimateJson,
    intake: intakeAddress(n),
  };
}

async function photosView(n: number) {
  const job = hub.jobs.exists(n) ? hub.jobs.get(n) : null;
  if (!job?.companycamProjectId) return { linked: false, photos: [] };
  const [project, photos] = await Promise.all([hub.photos.project?.(job.companycamProjectId).catch(() => null) ?? Promise.resolve(null), hub.photos.listPhotos(job.companycamProjectId)]);
  // Mock photos are local files; serve those through the hub. Real ones load straight from CompanyCam.
  const src = (u: string) => (/^https?:/.test(u) ? u : `/api/fixture-photo/${encodeURIComponent(path.basename(u))}`);
  return {
    linked: true,
    kind: hub.photos.kind,
    projectId: job.companycamProjectId,
    url: project?.url ?? `https://app.companycam.com/projects/${job.companycamProjectId}`,
    embedUrl: project?.embedUrl ?? null,
    photos: photos.map((p) => ({ id: p.id, at: p.capturedAt, description: p.description, creator: p.creator, thumb: src(p.thumb || p.web), web: src(p.web), original: src(p.original), page: p.url })),
  };
}

// ---------------------------------------------------------------- mail

async function mailThread(id: string) {
  const t = await hub.gmail.getThread(id);
  // Which job is this about? Homebase's suggest door, from the addresses, job numbers and streets in it.
  const addresses = [...new Set(t.messages.flatMap((m) => [m.from, ...m.to, ...m.cc]).map((a) => a.match(/[\w.+-]+@[\w.-]+/)?.[0]?.toLowerCase()).filter((a): a is string => !!a && !a.endsWith("@forefrontteam.com")))];
  const text = t.messages.map((m) => `${m.subject} ${m.body}`).join(" ");
  const numbers = [...new Set([...text.matchAll(/(?:#|job\s*)(\d{4})\b/gi)].map((x) => x[1]))];
  const streets = [...new Set([...text.matchAll(/\b\d{2,6}\s+(?:[NSEW]\.?\s+)?[A-Z][a-z]+(?:\s[A-Z][a-z]+)?\s(?:St|Street|Ave|Avenue|Ct|Court|Dr|Drive|Rd|Road|Ln|Lane|Way|Blvd|Cir|Circle|Pl|Place|Pkwy|Trl|Ter)\b/g)].map((x) => x[0]))].slice(0, 10);
  const jobs = (await hub.homebase.suggestJobs?.({ addresses: addresses.slice(0, 50), numbers, streets }).catch(() => [])) ?? [];
  return { ...t, jobs: jobs.slice(0, 3).map((j) => ({ jobNumber: j.jobNumber, name: j.name, address: j.address, stage: j.stage })) };
}

function resolveAttachments(list: { job: number; path: string }[] = []) {
  return list.map((a) => {
    const file = path.join(hub.jobs.folder(a.job), a.path);
    if (!inside(file, hub.jobs.folder(a.job)) || !existsSync(file)) throw new Error(`Attachment not found: ${a.path}`);
    return file;
  });
}

// ---------------------------------------------------------------- routes

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url ?? "/", "http://localhost");
  const p = url.pathname;
  const q = (k: string) => url.searchParams.get(k) ?? "";
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
        gmailFull: hub.gmail.fullAccess?.() ?? false,
        companycam: hub.photos.kind,
        calendar: hub.calendar.kind,
        calendarConnected: hub.calendar.connected(),
        tasksConnected: hub.tasks.connected(),
        agent: !!cfg.anthropicApiKey,
        me: cfg.homebase.me,
        jobsRoot: cfg.jobsRoot,
      });
    }
    if (p === "/api/meta") {
      return send(res, 200, { fields: FIELDS, sections: SECTIONS, vocab: (await hub.homebase.vocabulary?.().catch(() => ({}))) ?? {}, reminderGroups: REMINDER_GROUPS });
    }
    if (p.startsWith("/api/fixture-photo/")) {
      const f = path.join(cfg.hubRoot, "fixtures", "photos", path.basename(decodeURIComponent(p.slice(19))));
      if (!existsSync(f)) return send(res, 404, { error: "not found" });
      res.writeHead(200, { "Content-Type": "image/jpeg" });
      return createReadStream(f).pipe(res);
    }

    // ---- Today
    if (p === "/api/today") {
      const upload = new Set((lastSync?.needsUpload ?? []).map((x) => x.jobNumber));
      return send(res, 200, { reminders: reminders(hub, { needsUpload: upload }), groups: REMINDER_GROUPS, lastSync: lastSync?.at ?? null, folders: hub.jobs.list().length, unfiled: inboxState(hub).unfiled, autoFiling: hub.gmail.kind === "google" && (hub.gmail.fullAccess?.() ?? false) });
    }
    // ---- the dashboard: everything on one page, from the job folders the sync keeps fresh (no extra Homebase calls)
    if (p === "/api/dashboard") {
      const upload = new Set((lastSync?.needsUpload ?? []).map((x) => x.jobNumber));
      const all = hub.jobs.list();
      const open = all.filter((j) => !["Payment Received", "Closed Lost"].includes(j.stage));
      const rem = reminders(hub, { needsUpload: upload });
      const byStage = STAGES.map((s) => {
        const js = open.filter((j) => j.stage === s);
        return { stage: s, count: js.length, amount: js.reduce((t, j) => t + (j.pulse.proposalAmount ?? 0), 0) };
      }).filter((x) => x.count);
      const proposals = open
        .filter((j) => j.stage === "Proposal Submitted")
        .map((j) => ({ jobNumber: j.jobNumber, name: j.name, amount: j.pulse.proposalAmount, lastTouchAt: j.pulse.lastTouchAt || j.stageSince, lastTouch: j.pulse.lastTouch, waiting: !!j.pulse.waiting }))
        .sort((a, b) => (b.amount ?? 0) - (a.amount ?? 0));
      const activity = all
        .flatMap((j) => j.log.filter((l) => !/^(Pulled from Homebase|From Homebase:)/.test(l.what)).map((l) => ({ ...l, jobNumber: j.jobNumber, name: j.name })))
        .sort((a, b) => b.at.localeCompare(a.at))
        .slice(0, 15);
      const count = (k: string) => rem.filter((r) => r.kind === k).length;
      const dayStart = new Date();
      dayStart.setHours(0, 0, 0, 0);
      const dayEnd = new Date(dayStart.getTime() + 864e5);
      const schedule = hub.calendar.connected() ? await hub.calendar.events({ start: dayStart.toISOString(), end: dayEnd.toISOString() }).catch(() => []) : [];
      const todayStr = new Date().toLocaleDateString("en-CA", { timeZone: "America/Denver" });
      const tasksDue = hub.tasks.connected() ? (await hub.tasks.tasks().catch(() => [])).filter((t) => !t.completed && t.due && t.due <= todayStr).sort((a, b) => (a.due ?? "").localeCompare(b.due ?? "")) : [];
      return send(res, 200, {
        totals: {
          open: open.length,
          waiting: count("reply"),
          estimate: count("estimate"),
          followup: count("followup"),
          proposalsOut: proposals.length,
          proposalsAmount: proposals.reduce((t, x) => t + (x.amount ?? 0), 0),
          stale: count("stale"),
        },
        byStage,
        proposals: proposals.slice(0, 12),
        schedule,
        tasksDue,
        tasksConnected: hub.tasks.connected(),
        calendarConnected: hub.calendar.connected(),
        activity,
        reminders: rem,
        groups: REMINDER_GROUPS,
        unfiled: inboxState(hub).unfiled,
        autoFiling: hub.gmail.kind === "google" && (hub.gmail.fullAccess?.() ?? false),
        lastSync: lastSync?.at ?? null,
        folders: all.length,
      });
    }
    if (p === "/api/plan" && req.method === "POST") {
      if (!cfg.anthropicApiKey) return send(res, 400, { error: "Claude is off on this machine (no Anthropic API key)." });
      const list = reminders(hub, { needsUpload: new Set((lastSync?.needsUpload ?? []).map((x) => x.jobNumber)) });
      const prompt = `Plan my day. Here is everything the hub thinks needs me, as JSON (kind, job, title, detail, days waiting):\n${JSON.stringify(list.slice(0, 60))}\n\nCheck my Google Calendar and my Google Tasks (due today and overdue) for today and the next few days (hub tools) so the plan fits around what's already booked. Put it in the order I should work it, most urgent first (an adjuster or homeowner waiting on me beats a stale job; money-heavy proposals before small ones). Give me a short numbered list, one line each: job #, name, what to do. For the top replies and follow-ups, read the thread or the job (hub tools) and draft the email in Gmail for me (drafts only; I'll send). Say which drafts you made.`;
      return send(res, 202, task("Plan my day", undefined, async () => (await import("../agent/run.js")).ask(hub, prompt)));
    }

    // ---- job list
    if (p === "/api/jobs" && req.method === "GET") {
      const jobs = await hub.homebase.listJobs({ openOnly: q("all") !== "1", details: true });
      const local = new Map(hub.jobs.list().map((j) => [j.jobNumber, j]));
      const rem = reminders(hub);
      return send(res, 200, jobs.map((j) => ({ ...j, flags: [...new Set(rem.filter((r) => r.jobNumber === j.jobNumber).map((r) => r.kind))], lastTouchAt: local.get(j.jobNumber)?.pulse.lastTouchAt || null })));
    }
    if (p === "/api/accounts") return send(res, 200, (await hub.homebase.searchAccounts?.(q("q"), q("kind") || undefined)) ?? []);

    const m = p.match(/^\/api\/jobs\/(\d+)(?:\/(.+))?$/);
    if (m) {
      const n = Number(m[1]);
      const action = m[2] ?? "";
      if (req.method === "GET") {
        if (action === "") return send(res, 200, await jobView(n));
        if (action === "timeline") return send(res, 200, await timeline(hub, n));
        if (action === "photos") return send(res, 200, await photosView(n));
        if (action.startsWith("file/")) {
          const file = path.join(hub.jobs.folder(n), decodeURIComponent(action.slice(5)));
          if (!inside(file, hub.jobs.folder(n)) || !existsSync(file)) return send(res, 404, { error: "not found" });
          res.writeHead(200, { "Content-Type": MIME[path.extname(file).toLowerCase()] ?? "application/octet-stream", "Content-Disposition": `inline; filename="${path.basename(file)}"` });
          return createReadStream(file).pipe(res);
        }
        const doc = action.match(/^hbdoc\/([\w-]+)$/);
        if (doc) {
          const docs = (await hub.homebase.documents?.(n)) ?? [];
          const d = docs.find((x) => x.id === doc[1]);
          if (!d || !hub.homebase.downloadDocument) return send(res, 404, { error: "not found" });
          const tmp = path.join(cfg.stateDir, "hbdocs", d.id);
          if (!existsSync(tmp)) await hub.homebase.downloadDocument(d, tmp);
          res.writeHead(200, { "Content-Type": d.mimeType || "application/octet-stream", "Content-Disposition": `inline; filename="${d.fileName.replace(/"/g, "")}"` });
          return createReadStream(tmp).pipe(res);
        }
        return send(res, 404, { error: "not found" });
      }
      if (req.method !== "POST") return send(res, 405, { error: "method" });
      if (action === "upload") {
        const name = decodeURIComponent(String(req.headers["x-filename"] ?? "file"));
        const bytes = await rawBody(req);
        return send(res, 202, task(`Add ${name} to #${n}`, n, () => addFile(hub, n, name, bytes, { toHomebase: q("homebase") !== "0" }), "job"));
      }
      const b = await body(req);
      switch (action) {
        case "pull":
          return send(res, 202, task(`Refresh #${n} from Homebase`, n, () => pullJob(hub, n), "job"));
        case "fields":
          return send(res, 202, task(`Save fields on #${n}`, n, () => editFields(hub, n, b.changes ?? {}, b.labels ?? {}), "job"));
        case "adjuster":
          return send(res, 202, task(`Set adjuster on #${n}`, n, () => setAdjuster(hub, n, b.slot === 2 ? 2 : 1, { first: b.first ?? "", last: b.last ?? "", email: b.email || undefined, phone: b.phone || undefined }), "job"));
        case "contact":
          return send(res, 202, task(`Update ${b.name ?? "contact"}`, n, () => editContact(hub, n, b.contactId, b.name ?? "contact", { first: b.first || undefined, last: b.last || undefined, email: b.email || undefined, phone: b.phone || undefined }), "job"));
        case "note":
          return send(res, 202, task(`Add a note to #${n}`, n, async () => {
            if (!(await approver.confirm(`Add this note to Homebase #${n}?`, [b.body]))) return hub.say("Not added.");
            await hub.homebase.addNote(n, { kind: "note", body: b.body });
            hub.jobs.log(n, `Homebase note: ${String(b.body).slice(0, 80)}`);
            hub.say(`Added the note to Homebase #${n}.`);
          }, "timeline"));
        case "log":
          return send(res, 202, task(`Log a ${b.kind} on #${n}`, n, async () => {
            if (!(await approver.confirm(`Add this ${b.kind} to Homebase #${n}?`, [b.body, b.who ? `with ${b.who}` : ""].filter(Boolean)))) return hub.say("Not logged.");
            await hub.homebase.addNote(n, { kind: b.kind, body: b.body, who: b.who || undefined, direction: b.direction });
            hub.jobs.log(n, `Homebase ${b.kind}: ${String(b.body).slice(0, 80)}`);
            hub.say(`Logged the ${b.kind} on Homebase #${n}.`);
            bus.emit({ type: "changed", job: n, what: "timeline" });
            if (b.kind === "call") await noteAfter(n, "call", `${b.direction ?? "Outbound"} call${b.who ? ` with ${b.who}` : ""}: ${b.body}`);
          }, "timeline"));
        case "sendoff": {
          const to: Recipient[] = b.to?.length ? b.to : ["homeowner"];
          return send(res, 202, task(`Draft send-off for #${n} (${to.join(" + ")})`, n, async () => {
            const useTemplate = b.template || cfg.mode === "mock" || !cfg.anthropicApiKey;
            const writer = useTemplate ? new TemplateWriter() : new (await import("../agent/writer.js")).AgentWriter(hub);
            if (useTemplate) hub.say("Using plain template wording (no Claude API key on this machine).");
            await sendoff(hub, n, { to, writer, cc: b.cc ? String(b.cc).split(",").map((s: string) => s.trim()) : undefined });
          }, "timeline"));
        }
        case "sync":
          return send(res, 202, task(`Check sent emails for #${n}`, n, async () => {
            const before = hub.jobs.get(n).sendoff.homebaseLoggedAt;
            const r = await sync(hub, n);
            hub.say(r.length ? r.map((x) => `#${x.jobNumber}: ${x.sent.length ? `sent ${x.sent.join(", ")}; ` : ""}${x.logged ? "logged in Homebase" : "not logged yet"}${x.note ? ` (${x.note})` : ""}`).join("\n") : "No send-off drafts on this job yet.");
            const after = hub.jobs.get(n);
            if (!before && after.sendoff.homebaseLoggedAt) {
              await noteAfter(n, "send-off", after.sendoff.drafts.filter((d) => d.sentAt).map((d) => `Sent the ${d.kind} "${d.subject}" to ${d.to.join(", ")} with ${d.attachments.join(", ")}`).join("\n") + (after.sendoff.proposalAmount ? `\nProposal amount $${after.sendoff.proposalAmount}` : ""));
            }
          }, "timeline"));
        case "files-sync":
          return send(res, 202, task(`Sync files with Homebase #${n}`, n, async () => {
            const r = await syncFiles(hub, n);
            hub.say(`#${n}: ${r.docs.length} file${r.docs.length === 1 ? "" : "s"} in Homebase${r.downloaded.length ? `, downloaded ${r.downloaded.join(", ")}` : ", all already in the folder"}${r.toUpload.length ? `; not in Homebase yet: ${r.toUpload.map((f) => f.name).join(", ")}` : ""}.`);
          }, "job"));
        case "files-upload":
          return send(res, 202, task(`Upload files to Homebase #${n}`, n, () => uploadToHomebase(hub, n, b.names), "job"));
        case "mock-send": {
          if (!(hub.gmail instanceof MockGmail)) return send(res, 400, { error: "Only with the mock Gmail" });
          for (const d of hub.jobs.get(n).sendoff.drafts) if (!d.sentAt) hub.gmail.markSent(d.id);
          return send(res, 200, { ok: true });
        }
        default:
          return send(res, 404, { error: `unknown action ${action}` });
      }
    }

    // ---- mail
    if (p === "/api/mail/labels") return send(res, 200, (await hub.gmail.labels?.()) ?? []);
    if (p === "/api/mail/threads" && req.method === "GET") {
      if (!hub.gmail.listThreads) return send(res, 400, { error: "This Gmail connection can't list mail." });
      return send(res, 200, await hub.gmail.listThreads({ label: q("label") || undefined, q: q("q") || undefined, pageToken: q("page") || undefined }));
    }
    const t = p.match(/^\/api\/mail\/threads\/([\w-]+)(?:\/(modify))?$/);
    if (t && req.method === "GET") return send(res, 200, await mailThread(t[1]));
    if (t && t[2] === "modify" && req.method === "POST") {
      const b = await body(req);
      await hub.gmail.modifyThread?.(t[1], b);
      return send(res, 200, { ok: true });
    }
    const att = p.match(/^\/api\/mail\/attachment\/([\w-]+)\/([\w-]+)$/);
    if (att) {
      if (!hub.gmail.attachment) return send(res, 404, { error: "not found" });
      const buf = await hub.gmail.attachment(att[1], att[2]);
      const name = q("name") || "attachment";
      res.writeHead(200, { "Content-Type": MIME[path.extname(name).toLowerCase()] ?? "application/octet-stream", "Content-Disposition": `inline; filename="${name.replace(/"/g, "")}"` });
      return res.end(buf);
    }
    if (p === "/api/mail/send" && req.method === "POST") {
      const b = await body(req);
      if (!hub.gmail.send) return send(res, 400, { error: "This Gmail connection can't send." });
      if (hub.gmail.fullAccess && !hub.gmail.fullAccess()) return send(res, 400, { error: "Gmail needs to be reconnected once to send from the hub: double-click Connect Gmail." });
      const split = (s: unknown) => String(s ?? "").split(/[,;]/).map((x) => x.trim()).filter(Boolean);
      const d = { to: split(b.to), cc: split(b.cc), bcc: split(b.bcc), subject: String(b.subject ?? ""), body: String(b.body ?? ""), attachments: resolveAttachments(b.attachments), threadId: b.threadId || undefined, inReplyTo: b.inReplyTo || undefined };
      if (!d.to.length) return send(res, 400, { error: "Add at least one recipient." });
      const job = b.jobNumber ? Number(b.jobNumber) : undefined;
      return send(res, 202, task(`Send "${d.subject}"`, job, async () => {
        const lines = [`To: ${d.to.join(", ")}`, d.cc.length ? `Cc: ${d.cc.join(", ")}` : "", d.bcc.length ? `Bcc: ${d.bcc.join(", ")}` : "", `Subject: ${d.subject}`, d.attachments.length ? `Attached: ${d.attachments.map((f) => path.basename(f)).join(", ")}` : ""].filter(Boolean);
        if (!(await approver.confirm("Send this email now?", lines))) return hub.say("Not sent. It's still in the compose box.");
        await hub.gmail.send!(d);
        hub.say(`Sent "${d.subject}" to ${d.to.join(", ")}.`);
        bus.emit({ type: "changed", what: "mail" });
        if (job) {
          hub.jobs.log(job, `Emailed ${d.to.join(", ")}: ${d.subject}`);
          await noteAfter(job, "email", `To ${d.to.join(", ")}${d.cc.length ? `, cc ${d.cc.join(", ")}` : ""}\nSubject: ${d.subject}\n\n${d.body}`);
        }
      }, "mail"));
    }
    // ---- calendar
    if (p === "/api/cal/calendars") return send(res, 200, await hub.calendar.calendars());
    if (p === "/api/cal/events" && req.method === "GET") {
      const ids = q("cals") ? q("cals").split(",") : undefined;
      return send(res, 200, await hub.calendar.events({ start: q("start"), end: q("end"), calendarIds: ids, q: q("q") || undefined }));
    }
    if (p === "/api/cal/free") {
      const days = Number(q("days") || 5), minutes = Number(q("minutes") || 60);
      const from = new Date();
      const to = new Date(from.getTime() + (days + 2) * 864e5);
      const busy = await hub.calendar.busy({ start: from.toISOString(), end: to.toISOString() });
      return send(res, 200, freeSlots(busy, { from, days, minutes }));
    }
    if (p === "/api/cal/events" && req.method === "POST") {
      const b = await body(req);
      const ev = await hub.calendar.create(b);
      if (b.jobNumber && hub.jobs.exists(Number(b.jobNumber))) hub.jobs.log(Number(b.jobNumber), `Calendar: ${b.title} on ${new Date(b.start).toLocaleString("en-US", { timeZone: "America/Denver" })}`);
      bus.emit({ type: "changed", what: "calendar" });
      return send(res, 200, ev);
    }
    const ce = p.match(/^\/api\/cal\/events\/([^/]+)\/([^/]+)$/);
    if (ce && req.method === "PATCH") {
      const b = await body(req);
      return send(res, 200, await hub.calendar.update(decodeURIComponent(ce[1]), decodeURIComponent(ce[2]), b));
    }
    if (ce && req.method === "DELETE") {
      await hub.calendar.remove(decodeURIComponent(ce[1]), decodeURIComponent(ce[2]));
      return send(res, 200, { ok: true });
    }

    // ---- Google Tasks (the real lists: what's made here shows on the phone, and the other way round)
    if (p === "/api/tasks/lists") return send(res, 200, await hub.tasks.lists());
    if (p === "/api/tasks" && req.method === "GET") {
      return send(res, 200, await hub.tasks.tasks({ showCompleted: q("completed") === "1", dueMin: q("start") || undefined, dueMax: q("end") || undefined }));
    }
    if (p === "/api/tasks" && req.method === "POST") {
      const b = await body(req);
      const t = await hub.tasks.create({ listId: b.listId || undefined, title: String(b.title ?? "").trim() || "(no title)", notes: b.notes || undefined, due: b.due || undefined });
      if (b.jobNumber && hub.jobs.exists(Number(b.jobNumber))) hub.jobs.log(Number(b.jobNumber), `Task: ${t.title}${t.due ? ` (due ${t.due})` : ""}`);
      return send(res, 200, t);
    }
    const tk = p.match(/^\/api\/tasks\/([^/]+)\/([^/]+)$/);
    if (tk && req.method === "PATCH") return send(res, 200, await hub.tasks.update(decodeURIComponent(tk[1]), decodeURIComponent(tk[2]), await body(req)));
    if (tk && req.method === "DELETE") {
      await hub.tasks.remove(decodeURIComponent(tk[1]), decodeURIComponent(tk[2]));
      return send(res, 200, { ok: true });
    }

    // ---- filing emails to jobs (automatic in the background; these are the by-hand doors)
    if (p === "/api/inbox/file" && req.method === "POST") {
      const b = await body(req);
      const n = Number(b.jobNumber);
      return send(res, 202, task(`File email to #${n}`, n, async () => {
        const t = await hub.gmail.getThread(b.threadId);
        const me = cfg.gmail.address.toLowerCase();
        const ids: string[] = b.messageId ? [b.messageId] : t.messages.filter((m) => !m.from.toLowerCase().includes(me)).map((m) => m.id);
        const done = inboxState(hub).filed;
        let k = 0;
        for (const id of ids) if (!done[id] || done[id].jobNumber === 0) { await fileMessage(hub, b.threadId, id, n); k++; }
        hub.say(k ? `Filed ${k} email${k === 1 ? "" : "s"} to Homebase #${n}. Homebase picks it up in about 5 minutes.` : `Already filed to Homebase.`);
      }, "timeline"));
    }
    if (p === "/api/inbox/dismiss" && req.method === "POST") {
      const b = await body(req);
      dismissUnfiled(hub, b.messageId);
      return send(res, 200, { ok: true });
    }
    if (p === "/api/mail/draft" && req.method === "POST") {
      const b = await body(req);
      const split = (s: unknown) => String(s ?? "").split(/[,;]/).map((x) => x.trim()).filter(Boolean);
      const ref = await hub.gmail.createDraft({ to: split(b.to), cc: split(b.cc), bcc: split(b.bcc), subject: String(b.subject ?? ""), body: String(b.body ?? ""), attachments: resolveAttachments(b.attachments), threadId: b.threadId || undefined, inReplyTo: b.inReplyTo || undefined });
      return send(res, 200, { ok: true, id: ref.id });
    }

    // ---- sync, ask, approvals
    if (p === "/api/sync-all" && req.method === "POST") return send(res, 202, runSyncAll());
    if (p === "/api/sync-all" && req.method === "GET") return send(res, 200, { running: syncRunning, last: lastSync });
    if (p === "/api/ask" && req.method === "POST") {
      const b = await body(req);
      if (!cfg.anthropicApiKey) return send(res, 400, { error: "Claude is off on this machine (no Anthropic API key). Set ANTHROPIC_API_KEY in .env, or save it in the Estimator app." });
      const job = b.job ? Number(b.job) : undefined;
      return send(res, 202, task(`Ask: ${String(b.prompt).slice(0, 60)}`, job, async () => (await import("../agent/run.js")).ask(hub, String(b.prompt), { jobNumber: job }), "timeline"));
    }
    const a = p.match(/^\/api\/approvals\/([\w-]+)$/);
    if (a && req.method === "POST") {
      const b = await body(req);
      return send(res, approver.answer(a[1], !!b.yes, typeof b.text === "string" ? b.text : undefined) ? 200 : 404, { ok: true });
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
  return task("Sync jobs with Homebase", undefined, async () => {
    try {
      lastSync = await syncAll(hub);
      const s = lastSync;
      hub.say(
        `Synced ${s.jobs} jobs` +
          (s.newFolders.length ? `; new folders: ${s.newFolders.map((n) => `#${n}`).join(", ")}` : "") +
          (s.newFiles.length ? `; new files on ${s.newFiles.map((f) => `#${f.jobNumber} (${f.files.length})`).join(", ")}` : "") +
          (s.errors.length ? `; ${s.errors.length} job(s) had errors: ${s.errors.map((e) => `#${e.jobNumber} ${e.error}`).join("; ")}` : "") +
          ".",
      );
      bus.emit({ type: "changed", what: "job" });
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

// ---- filing incoming job emails: every 5 minutes (needs Gmail connected with the Mail tab's access)
let filing = false;
async function runInbox() {
  if (filing) return;
  filing = true;
  try {
    const r = await autoFile(hub);
    for (const f of r.filed) {
      hub.say(`Filed "${f.subject}" to Homebase #${f.jobNumber}.`);
      bus.emit({ type: "changed", job: f.jobNumber, what: "timeline" });
    }
  } catch (e) {
    console.error("auto-file:", e);
  } finally {
    filing = false;
  }
}
const INBOX_MINUTES = Number(process.env.HUB_INBOX_MINUTES || 5);
if (INBOX_MINUTES > 0 && hub.gmail.kind === "google") {
  setTimeout(runInbox, 30_000);
  setInterval(runInbox, INBOX_MINUTES * 60_000);
}

const port = Number(process.env.HUB_PORT || 4317);
const host = process.env.HUB_HOST || "127.0.0.1";
server.listen(port, host, () => {
  console.log(`Forefront hub running at http://${host === "0.0.0.0" ? "localhost" : host}:${port}`);
  for (const l of describe(hub)) console.log(`  ${l}`);
});
