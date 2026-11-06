import { createSdkMcpServer, tool } from "@anthropic-ai/claude-agent-sdk";
import { createGeneratedDraft } from "../workflows/generated.js";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { z } from "zod";
import { pickProject } from "../connectors/companycam/index.js";
import { intakeAddress } from "../connectors/homebase/types.js";
import { STAGES, type SendoffDraft } from "../core/job.js";
import type { Hub } from "../hub.js";
import { downloadPhotos, pullJob } from "../workflows/pull.js";
import { estimateFiles } from "../workflows/sendoff.js";
import { sync } from "../workflows/sync.js";

export const SERVER = "hub";

const ok = (data: unknown) => ({ content: [{ type: "text" as const, text: typeof data === "string" ? data : JSON.stringify(data, null, 2) }] });
const fail = (e: unknown) => ({ content: [{ type: "text" as const, text: `Error: ${(e as Error).message ?? e}` }], isError: true });
const wrap = <A>(fn: (a: A) => Promise<unknown>) => async (a: A) => {
  try {
    return ok(await fn(a));
  } catch (e) {
    return fail(e);
  }
};

const jobNumber = z.number().int().describe("Homebase job number, e.g. 3226");

/**
 * The hub's tools for the agent. Irreversible ones (Homebase writes) ask Hunter through hub.approver inside the
 * handler, so they're safe no matter how the agent calls them. There is no "send email" tool.
 */
export function hubTools(hub: Hub) {
  const tools = [
    // ---------------------------------------------------------------- job folder
    tool("job_list", "List the local job folders (job.json summaries).", {}, wrap(async () =>
      hub.jobs.list().map((j) => ({ jobNumber: j.jobNumber, name: j.name, address: j.address, stage: j.stage, estimate: j.estimate.status, folder: hub.jobs.folder(j.jobNumber) })),
    )),
    tool("job_get", "Read a job's job.json plus the files in its folder (sketch, photos, estimate, email, notes).", { jobNumber }, wrap(async ({ jobNumber: n }) => ({
      folder: hub.jobs.folder(n),
      job: hub.jobs.get(n),
      files: Object.fromEntries((["sketch", "estimate", "email", "notes"] as const).map((s) => [s, hub.jobs.files(n, s).map((f) => path.basename(f))])),
      photos: hub.jobs.files(n, "photos", /\.(jpe?g|png)$/i).length,
    }))),
    tool(
      "job_pull",
      "Refresh a job from Homebase into its job folder (creates the folder if new) and link its CompanyCam project and DocuSketch sketch.",
      { jobNumber },
      wrap(async ({ jobNumber: n }) => pullJob(hub, n)),
    ),
    tool(
      "job_update",
      "Set facts on job.json that Homebase doesn't have or got wrong (contacts, claim, insurance status, market, date of loss, estimate total).",
      {
        jobNumber,
        customerName: z.string().optional(),
        customerEmail: z.string().optional(),
        adjusterName: z.string().optional(),
        adjusterEmail: z.string().optional(),
        adjusterPhone: z.string().optional(),
        carrier: z.string().optional(),
        claimNumber: z.string().optional(),
        dateOfLoss: z.string().optional(),
        insurance: z.enum(["claim", "oop", "unknown"]).optional(),
        market: z.string().optional().describe("CODE8X (Denver metro) or COBO8X (Boulder County)"),
        estimateTotal: z.number().optional(),
      },
      wrap(async (a) => {
        const j = hub.jobs.get(a.jobNumber);
        return hub.jobs.upsert(a.jobNumber, {
          customer: { name: a.customerName, email: a.customerEmail },
          adjuster: { name: a.adjusterName, email: a.adjusterEmail, phone: a.adjusterPhone },
          carrier: a.carrier,
          claimNumber: a.claimNumber,
          dateOfLoss: a.dateOfLoss,
          insurance: a.insurance,
          market: a.market,
          estimate: a.estimateTotal !== undefined ? { ...j.estimate, total: a.estimateTotal } : undefined,
        });
      }),
    ),

    // ---------------------------------------------------------------- Homebase
    tool("homebase_list_jobs", "Jobs on the Homebase reconstruction dashboard: number, name, stage, days in stage.", { openOnly: z.boolean().default(true) }, wrap(async ({ openOnly }) => hub.homebase.listJobs({ openOnly }))),
    tool("homebase_get_job", "Read a job from Homebase: stage, contacts, carrier, claim, financials, intake email, and the page text.", { jobNumber }, wrap(async ({ jobNumber: n }) => hub.homebase.getJob(n))),
    tool(
      "homebase_set_proposal",
      "Set the proposal amount AND proposal submitted date together (the follow-up sequence keys off the date). Asks Hunter first. Normally `hub_sync` does this after the send-off emails go out.",
      { jobNumber, amount: z.number().positive(), submittedAt: z.string().describe("YYYY-MM-DD, the day the proposal was emailed") },
      wrap(async ({ jobNumber: n, amount, submittedAt }) => {
        if (!(await hub.approver.confirm(`Set Homebase #${n} proposal to $${amount.toFixed(2)}, submitted ${submittedAt}?`))) return "Hunter declined; nothing changed.";
        await hub.homebase.setProposal(n, { amount, submittedAt });
        hub.jobs.log(n, `Homebase: proposal $${amount.toFixed(2)} on ${submittedAt}`);
        return "Done.";
      }),
    ),
    tool(
      "homebase_set_stage",
      `Move a job to another Homebase stage. Asks Hunter first. Stages: ${STAGES.join(", ")}.`,
      { jobNumber, stage: z.enum(STAGES) },
      wrap(async ({ jobNumber: n, stage }) => {
        const cur = (await hub.homebase.getJob(n)).stage;
        if (!(await hub.approver.confirm(`Move Homebase #${n} from ${cur || "?"} to ${stage}?`))) return "Hunter declined; nothing changed.";
        await hub.homebase.setStage(n, stage);
        hub.jobs.log(n, `Homebase: stage ${cur} -> ${stage}`);
        return "Done.";
      }),
    ),
    tool(
      "homebase_add_note",
      "Log a note or a phone call on the Homebase job. Asks Hunter first (shows the exact text).",
      { jobNumber, kind: z.enum(["note", "call"]), body: z.string() },
      wrap(async ({ jobNumber: n, kind, body }) => {
        if (!(await hub.approver.confirm(`Add this ${kind} to Homebase #${n}?`, body.split("\n")))) return "Hunter declined; nothing changed.";
        await hub.homebase.addNote(n, { kind, body });
        if (hub.jobs.exists(n)) {
          const f = hub.jobs.path(n, "notes", "notes.txt");
          writeFileSync(f, `${existsSync(f) ? readFileSync(f, "utf8") : ""}[${new Date().toISOString().slice(0, 16)}] ${kind}: ${body}\n`);
          hub.jobs.log(n, `Homebase ${kind} logged`);
        }
        return "Done.";
      }),
    ),

    // ---------------------------------------------------------------- Gmail (drafts only)
    tool("gmail_search", "Search Hunter's Forefront Gmail (Gmail search syntax).", { query: z.string(), max: z.number().int().default(10) }, wrap(async ({ query, max }) => hub.gmail.search(query, max))),
    tool("gmail_read_thread", "Read every message in a Gmail thread.", { threadId: z.string() }, wrap(async ({ threadId }) => hub.gmail.getThread(threadId))),
    tool(
      "gmail_create_draft",
      "Create a Gmail DRAFT (never sent; Hunter sends it). With a jobNumber the job's Homebase log address is BCC'd automatically. kind: 'homeowner' / 'adjuster' only for an estimate send-off (it is then tracked for logging the proposal); 'other' for replies, follow-ups and everything else. To reply in a thread, pass threadId (the draft goes into that conversation). Attachments are local file paths (the PDFs in the job's estimate/ folder). Write in Hunter's voice per the forefront-estimate skill's step 6; his Gmail signature is appended, so don't add one.",
      {
        jobNumber: jobNumber.optional(),
        kind: z.enum(["homeowner", "adjuster", "other"]).default("other"),
        to: z.array(z.string()).min(1),
        cc: z.array(z.string()).default([]),
        subject: z.string(),
        body: z.string(),
        attachments: z.array(z.string()).default([]),
        threadId: z.string().optional().describe("to draft a reply inside an existing thread"),
      },
      wrap(async (a) => {
        const bcc = a.jobNumber ? [intakeAddress(a.jobNumber)] : [];
        const files = a.attachments.map((f) => (path.isAbsolute(f) || !a.jobNumber ? f : hub.jobs.path(a.jobNumber, f)));
        let inReplyTo: string | undefined;
        if (a.threadId) inReplyTo = (await hub.gmail.getThread(a.threadId).catch(() => null))?.messages.at(-1)?.messageIdHeader;
        const ref = await createGeneratedDraft(hub, { to: a.to, cc: a.cc, bcc, subject: a.subject, body: a.body, attachments: files, threadId: a.threadId, inReplyTo }, { jobNumber: a.jobNumber });
        if (a.jobNumber && hub.jobs.exists(a.jobNumber)) hub.jobs.log(a.jobNumber, `Draft "${a.subject}" to ${a.to.join(", ")}`);
        if (a.jobNumber && hub.jobs.exists(a.jobNumber) && a.kind !== "other") {
          const j = hub.jobs.get(a.jobNumber);
          const d: SendoffDraft = { id: ref.id, kind: a.kind, to: a.to, subject: a.subject, messageId: ref.messageId, attachments: files.map((f) => path.basename(f)), createdAt: new Date().toISOString() };
          hub.jobs.upsert(a.jobNumber, { sendoff: { ...j.sendoff, drafts: [...j.sendoff.drafts, d], homebaseLoggedAt: null } });
          hub.jobs.log(a.jobNumber, `Draft (${a.kind}) "${a.subject}"`);
        }
        return { draftId: ref.id, bcc, note: "Draft created in Gmail. Hunter reviews and sends it." };
      }),
    ),
    tool(
      "hub_sync",
      "Check which send-off drafts Hunter has sent; for those, update Homebase (proposal amount + real send date, stage -> Proposal Submitted), asking first.",
      { jobNumber: jobNumber.optional() },
      wrap(async ({ jobNumber: n }) => sync(hub, n)),
    ),

    // ---------------------------------------------------------------- what needs Hunter, and a job's history
    tool(
      "hub_today",
      "Everything that needs Hunter right now: emails waiting on a reply, jobs needing an estimate, proposals to follow up, untouched jobs, send-offs to log, unsent drafts, files to upload.",
      {},
      wrap(async () => (await import("../workflows/reminders.js")).reminders(hub)),
    ),
    tool(
      "job_timeline",
      "A job's whole history, newest first: Homebase notes, calls/texts/meetings, every email (Homebase-filed and Gmail, with threadId), drafts.",
      { jobNumber },
      wrap(async ({ jobNumber: n }) => (await import("../workflows/timeline.js")).timeline(hub, n)),
    ),
    tool(
      "homebase_update_fields",
      "Change fields on the Homebase job (Hunter is shown each old -> new value and must OK it). Keys: detail, propertyType, estimator, preferredContactMethod, picturesLink, fundingType, claimStatus, claimNumber, carrier (an account id from homebase_find_account), deductible, poWoNumber, proposalAmount (also restamps the proposal date to today), estimatedCosts, desiredMargin, mitEstimatedInvoice, lockboxCode, gateCode, alarm, pets, parking, elevatorAccess, accessNotes, customerNotes, pmNotes, toolAccess, address ({street, unit, city, state, zip}).",
      { jobNumber, changes: z.record(z.string(), z.any()) },
      wrap(async ({ jobNumber: n, changes }) => (await import("../workflows/fields.js")).editFields(hub, n, changes) ?? "Hunter declined; nothing changed."),
    ),
    tool(
      "homebase_set_adjuster",
      "Put an adjuster on the Homebase job (adds the person, or reuses the one Homebase has by that exact name). Asks Hunter first.",
      { jobNumber, slot: z.union([z.literal(1), z.literal(2)]).default(1), first: z.string(), last: z.string(), email: z.string().optional(), phone: z.string().optional() },
      wrap(async ({ jobNumber: n, slot, ...a }) => (await import("../workflows/fields.js")).setAdjuster(hub, n, slot, a) ?? "Hunter declined; nothing changed."),
    ),
    tool(
      "homebase_find_account",
      "Search Homebase accounts (carriers, agencies, vendors) by name; kind 'Carrier' for insurance companies.",
      { q: z.string().min(3), kind: z.string().optional() },
      wrap(async ({ q, kind }) => (await hub.homebase.searchAccounts?.(q, kind)) ?? []),
    ),

    tool(
      "inbox_file_email",
      "File a Gmail email (or every incoming message in a thread) to a job: forwards it to office+<job#> so Homebase logs it with its attachments, and saves the attachments in the job folder.",
      { threadId: z.string(), jobNumber, messageId: z.string().optional() },
      wrap(async ({ threadId, jobNumber: n, messageId }) => {
        const { fileMessage } = await import("../workflows/inbox.js");
        const t = await hub.gmail.getThread(threadId);
        const me = hub.cfg.gmail.address.toLowerCase();
        const ids = messageId ? [messageId] : t.messages.filter((m) => !m.from.toLowerCase().includes(me)).map((m) => m.id);
        for (const id of ids) await fileMessage(hub, threadId, id, n);
        return `Filed ${ids.length} email(s) to #${n}.`;
      }),
    ),
    tool(
      "homebase_upload_file",
      "Add a file from the job folder to the job's Documents tab in Homebase (asks Hunter first). kind: estimate, invoice, scope, contract, photo, report or other.",
      { jobNumber, path: z.string().describe("path inside the job folder, e.g. files/ITEL report.pdf"), kind: z.enum(["estimate", "invoice", "scope", "contract", "photo", "report", "other"]) },
      wrap(async ({ jobNumber: n, path: rel, kind }) => {
        const file = path.isAbsolute(rel) ? rel : hub.jobs.path(n, rel);
        if (!existsSync(file)) throw new Error(`No file ${rel} in #${n}'s folder`);
        if (!hub.homebase.uploadDocument) throw new Error("This Homebase connection can't upload.");
        if (!(await hub.approver.confirm(`Add ${path.basename(file)} to the Documents tab of Homebase #${n}?`, [`Filed as: ${kind}`]))) return "Hunter declined; nothing uploaded.";
        await hub.homebase.uploadDocument(n, file, { kind, title: path.basename(file) });
        return "Uploaded.";
      }),
    ),

    // ---------------------------------------------------------------- Google Calendar
    tool(
      "calendar_events",
      "Hunter's Google Calendar events between two times (ISO), all calendars unless calendarIds is given. Events that mention a job (#3226) carry jobNumber.",
      { start: z.string(), end: z.string(), q: z.string().optional() },
      wrap(async ({ start, end, q }) => hub.calendar.events({ start, end, q })),
    ),
    tool(
      "calendar_free_time",
      "Open weekday time (7am-5pm Denver) of at least `minutes` over the next `days` days, from Hunter's calendar.",
      { days: z.number().int().min(1).max(21).default(5), minutes: z.number().int().min(15).default(60) },
      wrap(async ({ days, minutes }) => {
        const { freeSlots } = await import("../connectors/calendar/index.js");
        const from = new Date();
        const busy = await hub.calendar.busy({ start: from.toISOString(), end: new Date(from.getTime() + (days + 2) * 864e5).toISOString() });
        return freeSlots(busy, { from, days, minutes });
      }),
    ),
    tool(
      "calendar_create_event",
      "Put an event on Hunter's Google Calendar (asks him first). Times are ISO with the -06:00/-07:00 Denver offset. For a job visit, put the job number and name in the title (\"Scope walk #3226 Augustine\") and the loss address in location. attendees get an invite.",
      { title: z.string(), start: z.string(), end: z.string(), allDay: z.boolean().optional(), location: z.string().optional(), description: z.string().optional(), attendees: z.array(z.string()).optional(), reminderMinutes: z.number().int().optional(), calendarId: z.string().optional(), jobNumber: jobNumber.optional() },
      wrap(async (a) => {
        const when = a.allDay ? a.start.slice(0, 10) : new Date(a.start).toLocaleString("en-US", { timeZone: "America/Denver", weekday: "short", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
        if (!(await hub.approver.confirm(`Add "${a.title}" to your calendar?`, [when, a.location ?? "", a.attendees?.length ? `Invites: ${a.attendees.join(", ")}` : ""].filter(Boolean)))) return "Hunter declined; nothing added.";
        const ev = await hub.calendar.create(a);
        if (a.jobNumber && hub.jobs.exists(a.jobNumber)) hub.jobs.log(a.jobNumber, `Calendar: ${a.title} ${when}`);
        return ev;
      }),
    ),
    tool(
      "calendar_update_event",
      "Move or change an event on Hunter's calendar (asks him first).",
      { calendarId: z.string(), eventId: z.string(), title: z.string().optional(), start: z.string().optional(), end: z.string().optional(), location: z.string().optional(), description: z.string().optional() },
      wrap(async ({ calendarId, eventId, ...e }) => {
        if (!(await hub.approver.confirm(`Change this calendar event?`, Object.entries(e).filter(([, v]) => v !== undefined).map(([k, v]) => `${k}: ${v}`)))) return "Hunter declined; nothing changed.";
        return hub.calendar.update(calendarId, eventId, e);
      }),
    ),
    tool(
      "calendar_delete_event",
      "Delete an event from Hunter's calendar (asks him first).",
      { calendarId: z.string(), eventId: z.string(), title: z.string().describe("the event's title, shown to Hunter") },
      wrap(async ({ calendarId, eventId, title }) => {
        if (!(await hub.approver.confirm(`Delete "${title}" from your calendar?`))) return "Hunter declined; nothing deleted.";
        await hub.calendar.remove(calendarId, eventId);
        return "Deleted.";
      }),
    ),

    // ---------------------------------------------------------------- Google Tasks
    tool(
      "tasks_list",
      "Hunter's Google Tasks (open ones; completed too if asked), optionally only those due between two dates (YYYY-MM-DD). Tasks that mention a job (#3226) carry jobNumber.",
      { dueMin: z.string().optional(), dueMax: z.string().optional(), showCompleted: z.boolean().default(false) },
      wrap(async ({ dueMin, dueMax, showCompleted }) => hub.tasks.tasks({ dueMin, dueMax, showCompleted })),
    ),
    tool(
      "tasks_create",
      "Add a Google Task for Hunter (asks him first); it shows on his phone right away. Put the job number in the title for job tasks (\"Call Eileen re #3226\"). due is a date, YYYY-MM-DD.",
      { title: z.string(), due: z.string().optional(), notes: z.string().optional(), listId: z.string().optional(), jobNumber: jobNumber.optional() },
      wrap(async (a) => {
        if (!(await hub.approver.confirm(`Add this task?`, [a.title, a.due ? `Due ${a.due}` : "No due date", a.notes ?? ""].filter(Boolean)))) return "Hunter declined; nothing added.";
        const t = await hub.tasks.create(a);
        if (a.jobNumber && hub.jobs.exists(a.jobNumber)) hub.jobs.log(a.jobNumber, `Task: ${a.title}`);
        return t;
      }),
    ),
    tool(
      "tasks_update",
      "Change a Google Task: retitle, move its due date, or mark it done / not done (asks Hunter first).",
      { listId: z.string(), taskId: z.string(), title: z.string().optional(), due: z.string().nullable().optional(), notes: z.string().optional(), completed: z.boolean().optional() },
      wrap(async ({ listId, taskId, ...t }) => {
        if (!(await hub.approver.confirm(`Change this task?`, Object.entries(t).filter(([, v]) => v !== undefined).map(([k, v]) => `${k}: ${v}`)))) return "Hunter declined; nothing changed.";
        return hub.tasks.update(listId, taskId, t);
      }),
    ),

    // ---------------------------------------------------------------- CompanyCam / DocuSketch
    tool("companycam_find_project", "Find CompanyCam projects by job number, name or street address.", { query: z.string() }, wrap(async ({ query }) => hub.photos.findProjects(query))),
    tool(
      "companycam_link_project",
      "Link a CompanyCam project to the job (stored in job.json). Without projectId, finds it by job number / address.",
      { jobNumber, projectId: z.string().optional() },
      wrap(async ({ jobNumber: n, projectId }) => {
        const j = hub.jobs.get(n);
        const id = projectId ?? pickProject([...(await hub.photos.findProjects(String(n))), ...(await hub.photos.findProjects(j.address.split(",")[0]))], n, j.address)?.id;
        if (!id) throw new Error("No matching CompanyCam project");
        return hub.jobs.upsert(n, { companycamProjectId: id }).companycamProjectId;
      }),
    ),
    tool(
      "companycam_download_photos",
      "Copy the job's CompanyCam photos into photos/previews (small) for looking through: photos/previews/index.json has dates and descriptions. Run the skill's photo_sheets.py on that folder. For full-size copies of particular photos, pass their file names in `only`.",
      { jobNumber, only: z.array(z.string()).optional().describe("file names to copy full size into photos/") },
      wrap(async ({ jobNumber: n, only }) => {
        const dir = only ? hub.jobs.path(n, "photos") : path.join(hub.jobs.path(n, "photos"), "previews");
        const files = await downloadPhotos(hub, n, only ? { size: "original", only } : { size: "web", dir });
        return { folder: dir, count: files.length };
      }),
    ),
    tool(
      "docusketch_find_sketch",
      "Find the job's DocuSketch sketch: the delivery email (project id) and the ESX, copied into the job's sketch/ folder from Downloads when it's there.",
      { jobNumber },
      wrap(async ({ jobNumber: n }) => {
        const j = hub.jobs.get(n);
        const d = j.docusketchProjectId ? { projectId: j.docusketchProjectId } : await hub.sketches.findDelivery({ name: j.name, address: j.address });
        if (d?.projectId && !j.docusketchProjectId) hub.jobs.upsert(n, { docusketchProjectId: d.projectId });
        const esx = await hub.sketches.fetchEsx({ projectId: d?.projectId, sketchDir: hub.jobs.path(n, "sketch") });
        return { delivery: d, esx, next: esx ? undefined : `Ask Hunter to download ${d?.projectId ?? "the"} ESX from https://app.docusketch.com/portal-cc/projects (or drop it in ${hub.jobs.path(n, "sketch")}).` };
      }),
    ),

    // ---------------------------------------------------------------- the skill's deterministic scripts
    tool(
      "estimate_status",
      "The job's estimate files and totals (from the skill's render.py math, without touching the PDFs).",
      { jobNumber },
      wrap(async ({ jobNumber: n }) => {
        const f = estimateFiles(hub, n);
        return { files: Object.fromEntries(Object.entries(f).map(([k, v]) => [k, v ? path.basename(v) : null])), totals: f.estimateJson ? await hub.skill.totals(f.estimateJson) : null };
      }),
    ),
    tool(
      "photo_report",
      "Build the adjuster's photo report from picked photos (files in the job's photos/ folder, one adjuster-facing caption each). Writes '<Last Name> - Photo Report.pdf' in estimate/.",
      {
        jobNumber,
        photos: z.array(z.object({ file: z.string(), caption: z.string(), room: z.string().optional() })).min(1),
        perPage: z.number().int().optional(),
      },
      wrap(async ({ jobNumber: n, photos, perPage }) => {
        const j = hub.jobs.get(n);
        const picks = hub.jobs.path(n, "photos", "report-picks.json");
        writeFileSync(picks, JSON.stringify({ customer: j.customer.name || undefined, address: j.address || undefined, claim_number: j.claimNumber || undefined, date_of_loss: j.dateOfLoss || undefined, photos }, null, 2));
        return hub.skill.photoReport({ picks, photosDir: hub.jobs.path(n, "photos"), estimateJson: estimateFiles(hub, n).estimateJson, outDir: hub.jobs.path(n, "estimate"), perPage });
      }),
    ),
  ];
  return createSdkMcpServer({ name: SERVER, version: "0.1.0", tools });
}
