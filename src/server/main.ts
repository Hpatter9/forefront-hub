#!/usr/bin/env node
import { createReadStream, existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import http, { type IncomingMessage, type ServerResponse } from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadConfig } from "../core/config.js";
import { describe, makeHub, type Hub } from "../hub.js";
import { MockGmail } from "../connectors/gmail/mock.js";
import { intakeAddress } from "../connectors/homebase/types.js";
import { pullJob, saveNotes, savedNotes } from "../workflows/pull.js";
import { noteAuthor, type HbNote } from "../connectors/homebase/types.js";
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
import { Studio } from "../agent/studio.js";
import { allContacts, findContacts, noteAddresses, noteMessages } from "../workflows/contacts.js";
import { BRIEF, briefDue } from "../workflows/brief.js";

/**
 * The hub's screen: a local web app on 127.0.0.1 (the desktop window will load the same thing). Every action runs the
 * same workflows as the CLI; anything that changes Homebase, sends an email or overwrites an estimate asks first.
 */
const HERE = path.dirname(fileURLToPath(import.meta.url));
const cfg = loadConfig();
const bus = new EventBus();
const approver = new WebApprover(bus);
const hub: Hub = makeHub(cfg, approver);
const studio = new Studio(hub, (e) => bus.emit({ type: "studio", ...e }));
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
  noteMessages(hub, t.messages);
  // Which job is this about? Homebase's suggest door, from the addresses, job numbers and streets in it.
  const addresses = [...new Set(t.messages.flatMap((m) => [m.from, ...m.to, ...m.cc]).map((a) => a.match(/[\w.+-]+@[\w.-]+/)?.[0]?.toLowerCase()).filter((a): a is string => !!a && !a.endsWith("@forefrontteam.com")))];
  const text = t.messages.map((m) => `${m.subject} ${m.body}`).join(" ");
  const numbers = [...new Set([...text.matchAll(/(?:#|job\s*)(\d{4})\b/gi)].map((x) => x[1]))];
  const streets = [...new Set([...text.matchAll(/\b\d{2,6}\s+(?:[NSEW]\.?\s+)?[A-Z][a-z]+(?:\s[A-Z][a-z]+)?\s(?:St|Street|Ave|Avenue|Ct|Court|Dr|Drive|Rd|Road|Ln|Lane|Way|Blvd|Cir|Circle|Pl|Place|Pkwy|Trl|Ter)\b/g)].map((x) => x[0]))].slice(0, 10);
  const jobs = (await hub.homebase.suggestJobs?.({ addresses: addresses.slice(0, 50), numbers, streets }).catch(() => [])) ?? [];
  // Drafts in the thread are marked (and Claude's say what made them), so they can't be mistaken for sent mail.
  const { generatedDrafts } = await import("../workflows/generated.js");
  const gen = generatedDrafts(hub);
  const messages = t.messages.map((m) => {
    if (!m.labelIds?.includes("DRAFT")) return m;
    const g = gen.find((x) => (m.messageIdHeader && x.messageId === m.messageIdHeader) || x.draftId === m.id);
    return { ...m, draft: { generated: !!g, source: g?.source, jobNumber: g?.jobNumber } };
  });
  return { ...t, messages, jobs: jobs.slice(0, 3).map((j) => ({ jobNumber: j.jobNumber, name: j.name, address: j.address, stage: j.stage })) };
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
        emailTasks: (await import("../agent/emailTasks.js")).enabled(hub),
        agent: !!cfg.anthropicApiKey,
        me: cfg.homebase.me,
        jobsRoot: cfg.jobsRoot,
      });
    }
    // ---- Spotify: only the app's client ID lives on the hub (in .env); sign-in tokens stay in the browser.
    if (p === "/api/settings/spotify" && req.method === "GET") return send(res, 200, { clientId: cfg.spotify.clientId });
    if (p === "/api/settings/spotify" && req.method === "POST") {
      const b = await body(req);
      const id = String(b.clientId ?? "").trim();
      if (!/^[0-9a-f]{32}$/i.test(id)) return send(res, 400, { error: "That doesn't look like a Spotify Client ID (32 letters and numbers, from your app's Settings)." });
      const { setEnv } = await import("../cli/connect.js");
      setEnv({ SPOTIFY_CLIENT_ID: id });
      cfg.spotify.clientId = id;
      return send(res, 200, { ok: true });
    }
    if (p === "/api/notes/recent") return send(res, 200, { me: cfg.homebase.me, notes: recentNotes(Number(q("days") || 14)), people: teamPeople() });
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
          adjuster: count("adjuster"),
          proposalsOut: proposals.length,
          proposalsAmount: proposals.reduce((t, x) => t + (x.amount ?? 0), 0),
          stale: count("stale"),
        },
        byStage,
        proposals: proposals.slice(0, 12),
        schedule,
        travel: await import("../workflows/travel.js").then(async (t) => t.travelFor(hub, schedule, { calendars: await myCalendars() })).catch(() => ({})),
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
    if (p === "/api/plan" && req.method === "GET") return send(res, 200, { ...readPlan(), schedule: BRIEF });
    if (p === "/api/plan/check" && req.method === "POST") {
      // Tick an item of the brief off (or back on). Kept with the brief, so a new brief starts with none ticked.
      const b = await body(req);
      const cur = readPlan();
      if (!("startedAt" in cur) || cur.state === "running") return send(res, 409, { error: "There's no finished brief to tick off." });
      const done = { ...(cur.done ?? {}) };
      if (b.done) done[String(b.key)] = true;
      else delete done[String(b.key)];
      savePlan({ ...cur, done });
      bus.emit({ type: "changed", what: "plan" });
      return send(res, 200, { done });
    }
    if (p === "/api/plan" && req.method === "POST") {
      const r = startPlan("button");
      return "error" in r ? send(res, r.code, { error: r.error }) : send(res, 202, r);
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
        if (action === "notes") {
          let notes: HbNote[] = [], live = false;
          try {
            notes = (await hub.homebase.noteFeed?.(n)) ?? [];
            live = !!hub.homebase.noteFeed;
            if (live && hub.jobs.exists(n)) saveNotes(hub, n, notes);
          } catch {
            notes = hub.jobs.exists(n) ? savedNotes(hub, n) : [];
          }
          return send(res, 200, { notes, live, canReply: !!hub.homebase.replyNote, me: cfg.homebase.me, people: teamPeople() });
        }
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
      const rn = action.match(/^notes\/([\w-]+)\/reply$/);
      if (rn) {
        const text = String(b.body ?? "").trim();
        if (!text) return send(res, 400, { error: "Write the reply first." });
        if (!hub.homebase.replyNote) return send(res, 400, { error: "This Homebase connection can't reply to notes." });
        return send(res, 202, task(`Reply to a note on #${n}`, n, async () => {
          if (!(await approver.confirm(`Post this reply on the Notes tab of Homebase #${n}?`, [text]))) return hub.say("Not posted.");
          await hub.homebase.replyNote!(n, rn[1], text);
          hub.jobs.log(n, `Homebase note reply: ${text.slice(0, 80)}`);
          hub.say(`Replied on Homebase #${n}.`);
        }, "timeline"));
      }
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
    // ---- contacts: everyone from email and Homebase, filled out as more turns up
    if (p === "/api/contacts") {
      const query = q("q").trim();
      const list = query ? await findContacts(hub, query, { homebase: q("homebase") !== "0" }) : allContacts(hub).slice(0, 500);
      return send(res, 200, { total: allContacts(hub).length, contacts: list });
    }
    const ct = p.match(/^\/api\/contacts\/(.+)$/);
    if (ct && req.method === "GET") {
      const id = decodeURIComponent(ct[1]);
      let person = allContacts(hub).find((x) => x.id === id);
      if (person && q("refresh") === "1") {
        // Look the person up in Homebase by email, then by name, and fold in what it has.
        for (const term of [person.emails[0], person.name].filter((x): x is string => !!x && x.length >= 3)) {
          await findContacts(hub, term, { homebase: true, limit: 1 });
          person = allContacts(hub).find((x) => x.id === id) ?? person;
          if (person.homebaseId) break;
        }
      }
      return person ? send(res, 200, person) : send(res, 404, { error: "No such contact." });
    }
    if (p === "/api/mail/summaries" && req.method === "POST") {
      // One-line summaries for the rows on screen: the ones already written now, the rest as they're ready.
      const b = await body(req);
      const ms = await import("../agent/mailSummary.js");
      const threads = (Array.isArray(b.threads) ? b.threads : []).slice(0, 60).map((t: any) => ({ id: String(t.id), historyId: t.historyId ? String(t.historyId) : undefined }));
      ms.requestSummaries(hub, threads, () => bus.emit({ type: "changed", what: "summaries" }));
      return send(res, 200, { on: ms.enabled(hub), summaries: ms.summariesFor(hub, threads) });
    }
    if (p === "/api/mail/threads" && req.method === "GET") {
      if (!hub.gmail.listThreads) return send(res, 400, { error: "This Gmail connection can't list mail." });
      const list = await hub.gmail.listThreads({ label: q("label") || undefined, q: q("q") || undefined, pageToken: q("page") || undefined });
      const { generatedDrafts } = await import("../workflows/generated.js");
      noteAddresses(hub, list.threads.map((x) => ({ from: x.from, at: x.date })));
      const claude = new Set(generatedDrafts(hub).filter((g) => g.state === "draft" && g.threadId).map((g) => g.threadId!));
      return send(res, 200, { ...list, threads: list.threads.map((t) => ({ ...t, hasDraft: !!t.labelIds?.includes("DRAFT"), claudeDraft: claude.has(t.id) })) });
    }
    const t = p.match(/^\/api\/mail\/threads\/([\w-]+)(?:\/(modify))?$/);
    if (t && req.method === "GET") return send(res, 200, await mailThread(t[1]));
    if (t && t[2] === "modify" && req.method === "POST") {
      const b = await body(req);
      await hub.gmail.modifyThread?.(t[1], b);
      return send(res, 200, { ok: true });
    }
    // A draft in a thread: Send (only after Hunter confirms, with the recipients in front of him) or Delete.
    const dr = p.match(/^\/api\/mail\/drafts\/([\w-]+)\/(send|delete|save)$/);
    if (dr && req.method === "POST") {
      const msgId = dr[1];
      if (!hub.gmail.draftIdFor || !hub.gmail.sendDraft || !hub.gmail.deleteDraft) return send(res, 400, { error: "This Gmail connection can't do that." });
      const draftId = await hub.gmail.draftIdFor(msgId);
      if (!draftId) return send(res, 404, { error: "That draft isn't in Gmail any more (sent or deleted?)." });
      const th = q("thread") ? await hub.gmail.getThread(q("thread")).catch(() => null) : null;
      const m = th?.messages.find((x) => x.id === msgId);
      if (dr[2] === "save") {
        // Edited right in the conversation: same draft, same thread, attachments and Bcc kept.
        if (!hub.gmail.updateDraft) return send(res, 400, { error: "This Gmail connection can't edit drafts." });
        const b = await body(req);
        const split = (v: unknown) => String(v ?? "").split(/[,;]/).map((x) => x.trim()).filter(Boolean);
        const files: string[] = [];
        for (const a of m?.attachments ?? []) {
          const f = path.join(cfg.stateDir, "draft-attachments", draftId, a.filename.replace(/[<>:"/\\|?*]/g, "_"));
          if (!existsSync(f) && hub.gmail.attachment) {
            mkdirSync(path.dirname(f), { recursive: true });
            writeFileSync(f, await hub.gmail.attachment(m!.id, a.id));
          }
          if (existsSync(f)) files.push(f);
        }
        const prev = th?.messages.filter((x) => !x.labelIds?.includes("DRAFT")).at(-1);
        const { generatedDrafts, GENERATED_LABEL } = await import("../workflows/generated.js");
        const gen = generatedDrafts(hub).some((g) => g.draftId === draftId || (m?.messageIdHeader && g.messageId === m.messageIdHeader));
        const to = split(b.to);
        if (!to.length) return send(res, 400, { error: "Add at least one recipient." });
        const r = await hub.gmail.updateDraft(draftId, { to, cc: split(b.cc), bcc: b.bcc !== undefined ? split(b.bcc) : m?.bcc ?? [], subject: String(b.subject ?? m?.subject ?? ""), body: String(b.body ?? ""), attachments: files, threadId: prev ? q("thread") || undefined : undefined, inReplyTo: prev?.messageIdHeader, labels: gen ? [GENERATED_LABEL] : undefined }, m?.messageIdHeader);
        bus.emit({ type: "changed", what: "mail" });
        return send(res, 200, { ok: true, messageId: r.messageId });
      }
      if (dr[2] === "delete") {
        await hub.gmail.deleteDraft(draftId);
        bus.emit({ type: "changed", what: "mail" });
        return send(res, 200, { ok: true });
      }
      if (hub.gmail.fullAccess && !hub.gmail.fullAccess()) return send(res, 400, { error: "Gmail needs to be reconnected once to send from the hub: double-click Connect Gmail." });
      return send(res, 202, task(`Send draft "${m?.subject ?? ""}"`, undefined, async () => {
        const lines = m ? [`To: ${m.to.join(", ")}`, m.cc.length ? `Cc: ${m.cc.join(", ")}` : "", `Subject: ${m.subject}`, m.attachments.length ? `Attached: ${m.attachments.map((a) => a.filename).join(", ")}` : ""].filter(Boolean) : [];
        if (!(await approver.confirm("Send this draft now?", lines))) return hub.say("Not sent. It's still a draft.");
        await hub.gmail.sendDraft!(draftId);
        hub.say(`Sent "${m?.subject ?? "the draft"}"${m ? ` to ${m.to.join(", ")}` : ""}.`);
        bus.emit({ type: "changed", what: "mail" });
      }, "mail"));
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
        if (b.replaceDraft) await replaceDraft(String(b.replaceDraft));
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
    if (p === "/api/mail/generated") {
      // The Gmail tab's "Claude drafts" folder: drafts the hub made, shaped like the thread list.
      const { openGeneratedDrafts } = await import("../workflows/generated.js");
      const list = await openGeneratedDrafts(hub);
      const qq = q("q").toLowerCase();
      const rows = list.filter((g) => !qq || `${g.subject} ${g.to.join(" ")} ${g.snippet} ${g.jobNumber ?? ""}`.toLowerCase().includes(qq));
      return send(res, 200, { threads: rows.map((g) => ({ id: g.threadId ?? g.draftId, draftId: g.draftId, from: `To: ${g.to.join(", ")}`, to: g.to, subject: g.subject, snippet: g.snippet, date: g.createdAt, unread: false, starred: false, messageCount: 1, labelIds: ["DRAFT"], hasAttachments: g.attachments > 0, generated: { source: g.source, jobNumber: g.jobNumber } })), count: list.length });
    }
    if (p === "/api/travel/drive") {
      // A drive time on request, for any address: from the office unless another start is given.
      const to = q("to"), from = q("from") || cfg.travel.start;
      if (!to) return send(res, 400, { error: "No address to drive to." });
      const d = await hub.travel.drive(from, to, q("at") ? new Date(q("at")) : undefined).catch((e: Error) => ({ error: /fetch failed|ENOTFOUND|ECONN/i.test(e.message) ? "The map service didn't answer (no internet?)." : e.message }));
      if (!d) return send(res, 404, { error: `The map couldn't find "${to}". Check the address.` });
      if ("error" in d) return send(res, 502, d);
      return send(res, 200, { ...d, from, to, mapsUrl: `https://www.google.com/maps/dir/?${new URLSearchParams({ api: "1", origin: from, destination: to, travelmode: "driving" })}` });
    }
    if (p === "/api/cal/travel") {
      const { travelFor } = await import("../workflows/travel.js");
      const ev = await hub.calendar.events({ start: q("start"), end: q("end") });
      const why: Record<string, string> = {};
      const legs = await travelFor(hub, ev, { calendars: await myCalendars(), why });
      return send(res, 200, { kind: hub.travel.kind, start: cfg.travel.start, legs, why });
    }
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
      if (b.replaceDraft) await replaceDraft(String(b.replaceDraft));
      bus.emit({ type: "changed", what: "mail" });
      return send(res, 200, { ok: true, id: ref.id });
    }

    // ---- sync, ask, approvals
    if (p === "/api/sync-all" && req.method === "POST") return send(res, 202, runSyncAll());
    if (p === "/api/sync-all" && req.method === "GET") return send(res, 200, { running: syncRunning, last: lastSync });
    // ---- Estimator tab: a chat with Claude per job, using the forefront-estimate skill
    const st = p.match(/^\/api\/studio\/(\d+)(?:\/(send|stop|reset|upload))?$/);
    if (st) {
      const n = Number(st[1]);
      if (!hub.jobs.exists(n)) await pullJob(hub, n, { quiet: true });
      const j = hub.jobs.get(n);
      const job = { jobNumber: n, name: j.name, address: j.address, stage: j.stage, insurance: j.insurance, customer: j.customer.name, carrier: j.carrier, claimNumber: j.claimNumber, estimate: j.estimate };
      if (!st[2] && req.method === "GET") return send(res, 200, { job, claude: !!cfg.anthropicApiKey, ...studio.view(n) });
      if (req.method !== "POST") return send(res, 405, { error: "method" });
      if (st[2] === "upload") {
        const name = decodeURIComponent(String(req.headers["x-filename"] ?? "file"));
        const r = await addFile(hub, n, name, await rawBody(req), { toHomebase: false });
        return send(res, 200, { path: path.relative(hub.jobs.folder(n), r.file).split(path.sep).join("/"), sub: r.sub });
      }
      if (st[2] === "stop") return send(res, 200, (await studio.stop(n), { ok: true }));
      if (st[2] === "reset") return send(res, 200, (studio.reset(n), { ok: true }));
      const b = await body(req);
      const text = String(b.text ?? "").trim();
      if (!text) return send(res, 400, { error: "Say what you want Claude to do." });
      if (!cfg.anthropicApiKey) return send(res, 400, { error: "Claude is off on this machine (no Anthropic API key). Set ANTHROPIC_API_KEY in .env, or save it in the Estimator app." });
      if (studio.running(n)) return send(res, 409, { error: "Claude is still working on this job." });
      studio.send(n, text).then(() => bus.emit({ type: "changed", job: n, what: "job" })).catch((e) => console.error(e));
      return send(res, 202, { ok: true });
    }
    if (p === "/api/ask" && req.method === "POST") {
      const b = await body(req);
      if (!cfg.anthropicApiKey) return send(res, 400, { error: "Claude is off on this machine (no Anthropic API key). Set ANTHROPIC_API_KEY in .env, or save it in the Estimator app." });
      const job = b.job ? Number(b.job) : undefined;
      // The answer comes back as an "answer" event with what the hub should show: the drafts made (to open in Gmail),
      // the jobs and contacts Claude looked at (for buttons on the popup), and Claude's reply.
      const id = crypto.randomUUID();
      const prompt = String(b.prompt);
      const made: import("../workflows/generated.js").GeneratedDraft[] = [];
      const jobsSeen = new Set<number>(), contacts = new Set<string>();
      task(`Ask: ${prompt.slice(0, 60)}`, job, async () => {
        const { withDraftSource } = await import("../workflows/generated.js");
        let text = "", error: string | undefined;
        try {
          text = await withDraftSource("Claude", async () => (await import("../agent/run.js")).ask(hub, prompt, {
            jobNumber: job,
            onMessage: (m) => {
              if (m.type !== "assistant") return;
              for (const c of m.message.content) {
                if (c.type !== "tool_use") continue;
                const inp = c.input as Record<string, unknown>;
                if (typeof inp.jobNumber === "number") jobsSeen.add(inp.jobNumber);
                if (c.name.endsWith("contacts_find") && typeof inp.query === "string") contacts.add(inp.query);
              }
            },
          }), made);
        } catch (e) {
          error = (e as Error).message;
        }
        for (const x of text.matchAll(/#(\d{4})\b/g)) jobsSeen.add(Number(x[1]));
        bus.emit({ type: "answer", id, prompt, text, error, drafts: made.map((d) => ({ threadId: d.threadId || (hub.gmail.kind === "mock" ? d.draftId : undefined), subject: d.subject, to: d.to })), jobs: [...jobsSeen].slice(0, 4), contacts: [...contacts].slice(0, 3) });
        if (error) throw new Error(error);
      }, "timeline");
      return send(res, 202, { id });
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
    // Claude adds Google Tasks for what new emails ask of you.
    const { tasksFromInbox } = await import("../agent/emailTasks.js");
    const added = await tasksFromInbox(hub);
    for (const t of added) hub.say(`New task from email: ${t.title}`);
    if (added.length) bus.emit({ type: "changed", what: "calendar" });
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

// ---- Homebase Notes across every job folder (saved by the background sync), for the dashboard
function recentNotes(days: number) {
  const since = Date.now() - days * 86400_000;
  const me = cfg.homebase.me.toLowerCase();
  const first = me.split(" ")[0];
  const out: { jobNumber: number; name: string; noteId: string; replyTo?: string; author: string; via: string; body: string; at: string; mine: boolean; mentionsMe: boolean; thread?: string }[] = [];
  for (const j of hub.jobs.list()) {
    for (const n of savedNotes(hub, j.jobNumber)) {
      for (const x of [n, ...n.replies]) {
        const t = Date.parse(x.postedAt);
        if (!(t > since)) continue;
        const a = noteAuthor(x.author);
        const body = x.body.toLowerCase();
        out.push({ jobNumber: j.jobNumber, name: j.name, noteId: n.id, replyTo: x === n ? undefined : n.id, author: a.person, via: a.via, body: x.body, at: x.postedAt, mine: a.person.toLowerCase() === me, mentionsMe: body.includes(`@${me}`) || new RegExp(`@${first}\\b`).test(body), thread: x === n ? undefined : n.body.slice(0, 120) });
      }
    }
  }
  return out.sort((a, b) => b.at.localeCompare(a.at)).slice(0, 60);
}

/** Everyone who has written on a job's Notes tab: the names @mentions can use. */
function teamPeople() {
  const seen = new Map<string, number>();
  for (const j of hub.jobs.list()) for (const n of savedNotes(hub, j.jobNumber)) for (const x of [n, ...n.replies]) {
    const who = noteAuthor(x.author).person;
    if (who && /\s/.test(who)) seen.set(who, (seen.get(who) ?? 0) + 1);
  }
  return [...seen.entries()].sort((a, b) => b[1] - a[1]).map(([name]) => name).filter((x) => x.toLowerCase() !== cfg.homebase.me.toLowerCase());
}

// ---- Plan my day: the last brief Claude wrote, shown on the dashboard
interface Plan { state: "running" | "done" | "error"; startedAt: string; finishedAt?: string; text: string; steps: string[]; error?: string; trigger?: "button" | "morning"; /** Items ticked off on the Brief tab, by item key. */ done?: Record<string, boolean> }

function startPlan(trigger: "button" | "morning"): { taskId: string } | { error: string; code: number } {
  if (!cfg.anthropicApiKey) return { error: "Claude is off on this machine (no Anthropic API key).", code: 400 };
  if (readPlan().state === "running") return { error: "Claude is already planning your day.", code: 409 };
  const list = reminders(hub, { needsUpload: new Set((lastSync?.needsUpload ?? []).map((x) => x.jobNumber)) });
  const buildPrompt = (myDayNote: string) => `Plan my day. Here is everything the hub thinks needs me, as JSON (kind, job, title, detail, days waiting):\n${JSON.stringify(list.slice(0, 60))}\n\n${myDayNote}\n\nThis brief is only for me and my time. Rules:\n- Use ONLY the calendar events and tasks listed above. They are mine: my own calendar (not shared team calendars) and my own Google Tasks. Don't look up other calendars or tasks with the hub tools, and leave out other people's meetings and to-dos.\n- Every line in the brief is something I do. If something waits on someone else, either write it as my action (\"Ask Shannon whether the selections went out\") or leave it out.\n\nFor the top replies and follow-ups, read the thread or the job (hub tools) and draft the email in Gmail for me (drafts only; I'll send).\n\nYour final reply is my brief for the day, shown at the top of my dashboard. Write it in this shape, in markdown, and nothing else:\n**Today at a glance:** one or two sentences (what's booked, how many things are waiting, the one thing that matters most).\n\n**Do in this order**\n1. #<job> <Name>: what to do (one line each, most urgent first: an adjuster or homeowner waiting on me beats a stale job; money-heavy proposals before small ones).\n\n**On the calendar:** the day's appointments, one line each (skip if none).\n\n**Drafts ready in Gmail:** one line per draft you made (skip if none).`;
  const plan: Plan = { state: "running", startedAt: new Date().toISOString(), text: "", steps: [], trigger };
  savePlan(plan);

  bus.emit({ type: "changed", what: "plan" });
  return task(trigger === "morning" ? "Morning brief" : "Plan my day", undefined, async () => {
    const { describeTool } = await import("../agent/studio.js");
    try {
      const { withDraftSource } = await import("../workflows/generated.js");
      const note = await travelNote();
      const prompt = buildPrompt(await myDay());
      plan.text = await withDraftSource(trigger === "morning" ? "Morning brief" : "Plan my day", async () => (await import("../agent/run.js")).ask(hub, prompt + note, {
        onMessage: (m) => {
          if (m.type !== "assistant") return;
          for (const b of m.message.content) if (b.type === "tool_use") { plan.steps.push(describeTool(b.name, b.input as Record<string, unknown>)); savePlan(plan); bus.emit({ type: "changed", what: "plan" }); }
        },
      }));
      plan.state = "done";
    } catch (e) {
      plan.state = "error";
      plan.error = (e as Error).message;
      throw e;
    } finally {
      plan.finishedAt = new Date().toISOString();
      savePlan(plan);
      bus.emit({ type: "changed", what: "plan" });
    }
  });
}

// ---- the morning brief: on its own at 7:00 AM Denver time on weekdays (HUB_BRIEF_TIME=off stops it,
// HUB_BRIEF_DAYS=0-6 for every day). If the hub wasn't open at 7, it runs as soon as it opens, until 5 PM.
function checkBrief() {
  const last = readPlan();
  if (!cfg.anthropicApiKey || last.state === "running" || !briefDue(new Date(), "startedAt" in last ? last : null)) return;
  const r = startPlan("morning");
  if (!("error" in r)) hub.say("Making this morning's brief…");
}
if (BRIEF.at !== "off") {
  setTimeout(checkBrief, 60_000);
  setInterval(checkBrief, 60_000);
}
const planFile = () => path.join(cfg.stateDir, "plan.json");
function readPlan(): Plan | { state: "none" } {
  try {
    const p: Plan = JSON.parse(readFileSync(planFile(), "utf8"));
    // A run that was going when the hub closed never finished.
    if (p.state === "running" && Date.now() - Date.parse(p.startedAt) > 20 * 60_000) return { ...p, state: "error", error: "That plan didn't finish. Try again." };
    return p;
  } catch {
    return { state: "none" };
  }
}
function savePlan(p: Plan) {
  mkdirSync(cfg.stateDir, { recursive: true });
  writeFileSync(planFile(), JSON.stringify(p, null, 2));
}

/** Today's drive times, for Plan my day: when to leave for each appointment with an address. */
async function travelNote(): Promise<string> {
  if (!hub.calendar.connected()) return "";
  try {
    const d0 = new Date(), d1 = new Date();
    d0.setHours(0, 0, 0, 0);
    d1.setHours(24, 0, 0, 0);
    const ev = await hub.calendar.events({ start: d0.toISOString(), end: d1.toISOString() });
    const legs = await (await import("../workflows/travel.js")).travelFor(hub, ev, { calendars: await myCalendars() });
    const hm = (iso: string) => new Date(iso).toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit", timeZone: "America/Denver" });
    const lines = ev.filter((e) => legs[e.id]).map((e) => { const g = legs[e.id]; return `- ${hm(e.start)} ${e.title} at ${g.to}: ${g.minutes} min drive from ${g.fromLabel}${g.rush ? " (rush hour)" : ""}, leave by ${hm(g.leaveBy)}${g.late ? `; ${g.late} min short coming straight from ${g.fromLabel}` : ""}`; });
    return lines.length ? `\n\nDrive times for today's appointments (already worked out; use them, and put the leave-by time on each calendar line of the brief; call out any that are short):\n${lines.join("\n")}` : "";
  } catch {
    return "";
  }
}

/** Your own calendar (not shared team calendars): the one drive times are worked out for. */
async function myCalendars(): Promise<Set<string>> {
  const cals = await hub.calendar.calendars().catch(() => []);
  return new Set(["primary", ...cals.filter((c) => c.primary).map((c) => c.id)]);
}

/** After an edited draft is sent or saved again, the old version is removed so it isn't left behind. */
async function replaceDraft(messageId: string) {
  const id = await hub.gmail.draftIdFor?.(messageId).catch(() => null);
  if (id) await hub.gmail.deleteDraft?.(id).catch(() => {});
}

/** My calendar and my tasks for the brief: my own calendar only (no shared team calendars, nothing I declined) and
 *  my own Google Tasks, today through the next three days. */
async function myDay(): Promise<string> {
  const lines: string[] = [];
  const d0 = new Date(), d1 = new Date();
  d0.setHours(0, 0, 0, 0);
  d1.setDate(d1.getDate() + 3);
  d1.setHours(24, 0, 0, 0);
  const day = (iso: string) => new Date(iso.length === 10 ? `${iso}T12:00:00` : iso).toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric", timeZone: "America/Denver" });
  const hm = (iso: string) => new Date(iso).toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit", timeZone: "America/Denver" });
  if (hub.calendar.connected()) {
    const mine = await myCalendars();
    const ev = (await hub.calendar.events({ start: d0.toISOString(), end: d1.toISOString() }).catch(() => []))
      .filter((e) => mine.has(e.calendarId) && e.myResponse !== "declined")
      .sort((a, b) => a.start.localeCompare(b.start));
    lines.push("My calendar (my own calendar only), today and the next 3 days:", ...(ev.length ? ev.map((e) => `- ${day(e.start)} ${e.allDay ? "all day" : `${hm(e.start)}-${hm(e.end)}`}: ${e.title}${e.location ? ` @ ${e.location}` : ""}${e.myResponse === "tentative" ? " (maybe)" : ""}`) : ["- nothing booked"]));
  } else lines.push("My calendar: not connected.");
  if (hub.tasks.connected()) {
    const today = new Date().toLocaleDateString("en-CA", { timeZone: "America/Denver" });
    const soon = new Date(Date.now() + 86400_000).toLocaleDateString("en-CA", { timeZone: "America/Denver" });
    const ts = (await hub.tasks.tasks().catch(() => [])).filter((t) => !t.completed && t.due && t.due <= soon).sort((a, b) => (a.due ?? "").localeCompare(b.due ?? ""));
    lines.push("", "My Google Tasks due by tomorrow (and overdue):", ...(ts.length ? ts.map((t) => `- ${t.title}${t.due! < today ? ` (overdue since ${day(t.due!)})` : t.due === today ? " (due today)" : " (due tomorrow)"}`) : ["- none"]));
  } else lines.push("", "My Google Tasks: not connected.");
  return lines.join("\n");
}
