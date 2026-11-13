import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { aiProvider, BUSY_RX, complete } from "../agent/llm.js";
import { confirmText } from "../core/approval.js";
import type { Hub } from "../hub.js";
import { myEvents } from "./myEvents.js";

/**
 * Walk recordings: Hunter records a scope walk on his watch (his own notes and the conversation with the customer),
 * the recording reaches a folder on this PC (phone -> Google Drive -> Drive for desktop), and Keystone transcribes
 * it with Gemini, works out which job it belongs to (the calendar event at that time, else what's said in it),
 * and files the transcript and a structured summary in the job folder (notes/walks/). The Estimator reads those as a
 * source for the scope. Nothing leaves the PC except the audio sent to Gemini to be transcribed.
 */
export interface WalkNotes {
  transcript: string;
  summary: string;
  rooms: { room: string; notes: string }[];
  measurements: string[];
  customerWants: string[];
  promises: { what: string; due?: string }[];
  /** Clues to which job this is, as said in the recording. */
  address?: string;
  names?: string[];
  /** Stretches left out because they weren't the walk (recorder left running: a drive, a call, the radio), described, never transcribed. */
  leftOut?: string[];
}

/** Takes the "[Left out: ...]" markers out of a transcript and returns them separately. */
export function splitLeftOut(raw: string): { transcript: string; leftOut: string[] } {
  const leftOut: string[] = [];
  const transcript = raw
    .split("\n")
    .filter((line) => {
      const m = line.trim().match(/^\[\s*left out:?\s*(.*?)\]?$/i);
      if (m) leftOut.push(m[1].trim() || "something that wasn't the walk");
      return !m;
    })
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  return { transcript, leftOut };
}

export interface Walk {
  id: string; // file name + size
  file: string;
  name: string;
  recordedAt: string;
  status: "filed" | "needs-job" | "error";
  jobNumber?: number;
  why?: string; // how the job was picked
  candidates?: { jobNumber: number; name: string }[];
  summary?: string;
  promises?: { what: string; due?: string }[];
  notesFile?: string; // relative to the job folder once filed, else the holding copy
  error?: string;
  processedAt: string;
}

const AUDIO = /\.(m4a|mp3|wav|aac|ogg|oga|flac|3gp|amr|mp4|opus)$/i;
const MIME: Record<string, string> = { m4a: "audio/mp4", mp4: "audio/mp4", mp3: "audio/mp3", wav: "audio/wav", aac: "audio/aac", ogg: "audio/ogg", oga: "audio/ogg", opus: "audio/ogg", flac: "audio/flac", "3gp": "audio/3gpp", amr: "audio/amr" };

const stateFile = (hub: Hub) => path.join(hub.cfg.stateDir, "walks.json");
export function walks(hub: Hub): Walk[] {
  try {
    return existsSync(stateFile(hub)) ? JSON.parse(readFileSync(stateFile(hub), "utf8")) : [];
  } catch {
    return [];
  }
}
function save(hub: Hub, list: Walk[]) {
  mkdirSync(hub.cfg.stateDir, { recursive: true });
  writeFileSync(stateFile(hub), JSON.stringify(list, null, 2));
}

export function walksStatus(hub: Hub): { on: boolean; dir: string; problem?: string } {
  const dir = hub.cfg.walks.dir;
  if (!dir) return { on: false, dir: "", problem: "Walk recordings aren't set up. Double-click Connect walk recordings." };
  if (!existsSync(dir)) return { on: false, dir, problem: `The recordings folder isn't there: ${dir}` };
  return { on: true, dir };
}

/** When a recording was made: Samsung names files "Voice 251110_143005.m4a"; otherwise the file's own time. */
export function recordedAt(name: string, mtime: Date): Date {
  const m = name.match(/(\d{2}|\d{4})(\d{2})(\d{2})[_-](\d{2})(\d{2})(\d{2})/);
  if (m) {
    const d = new Date(Number(m[1].length === 2 ? `20${m[1]}` : m[1]), Number(m[2]) - 1, Number(m[3]), Number(m[4]), Number(m[5]), Number(m[6]));
    if (!Number.isNaN(d.getTime()) && Math.abs(d.getTime() - mtime.getTime()) < 400 * 864e5) return d;
  }
  return mtime;
}

const SCHEMA = {
  type: "object",
  properties: {
    summary: { type: "string", description: "3-6 sentences: what the walk covered and what was decided." },
    rooms: { type: "array", items: { type: "object", properties: { room: { type: "string" }, notes: { type: "string", description: "damage seen, what to remove/replace/repair, materials and finishes mentioned" } }, required: ["room", "notes"] } },
    measurements: { type: "array", items: { type: "string" }, description: "each measurement or count said out loud, with what it's of" },
    customerWants: { type: "array", items: { type: "string" }, description: "preferences, selections, upgrades, concerns, deadlines the customer voiced" },
    promises: { type: "array", items: { type: "object", properties: { what: { type: "string" }, due: { type: "string", description: "when, as said (\"Friday\"), if a time was given" } }, required: ["what"] }, description: "things Hunter said he would do" },
    address: { type: "string", description: "the property's street address if it's said" },
    names: { type: "array", items: { type: "string" }, description: "people's names said in the recording (customer, adjuster)" },
  },
  required: ["summary", "rooms", "measurements", "customerWants", "promises"],
};

/**
 * Transcribes and structures one recording with Gemini, in two steps: the words first (plain text, streamed, so an
 * hour-long walk doesn't time out or get cut off), then the estimator's notes from those words.
 */
export async function transcribe(hub: Hub, file: string): Promise<WalkNotes> {
  if (aiProvider(hub) !== "gemini" || !hub.gemini) throw new Error("Transcribing recordings needs Gemini (double-click Connect Gemini).");
  const ext = path.extname(file).slice(1).toLowerCase();
  const up = await hub.gemini.uploadFile(file, MIME[ext] ?? "audio/mp4");
  const { transcript, leftOut } = splitLeftOut(
    await complete<string>(hub, {
      system: "You transcribe site-walk recordings for a reconstruction estimator (water, fire and mold repairs). Write down only what is actually said during the walk, all of it, in order. Unclear words: [unclear].",
      prompt: `This is a recording from Hunter's scope walk at a customer's property: his own spoken notes and his conversation with the customer. Transcribe the walk as plain text, one speaker turn per line. Start a line with "Hunter:" for the estimator, "Customer:" (or the person's name) for others when you can tell, and "Note:" when Hunter is talking to himself.

Hunter sometimes forgets to stop the recorder, or starts it early. Transcribe ONLY the walk itself: time at the property looking at the damage, and talk about this property's damage, repairs, measurements, schedule or price (including a phone call about this same job). Do NOT transcribe anything else, wherever it falls in the recording: an audiobook, podcast, radio, music or TV; a phone call about something else; talk with a coworker or anyone else about other jobs or personal things; driving, errands, or background voices that aren't part of the walk. In place of each such stretch write exactly one line, with no words from it:
[Left out: <what kind of thing it was, e.g. "audiobook playing while driving" or "phone call not about this job">, about <N> minutes]
When unsure whether a stretch is about this property, keep it.

No headings, no summary, nothing but the transcript and those lines.`,
      files: [up],
      stream: true,
    }),
  );
  if (!transcript) throw new Error(leftOut.length ? `Nothing in that recording was a walk (left out: ${leftOut.join("; ")}).` : "Nothing could be heard in that recording.");
  const notes = await complete<Omit<WalkNotes, "transcript">>(hub, {
    system: "You organize site-walk transcripts for a reconstruction estimator. Use only what is in the transcript; never invent rooms, measurements or promises. If part of the transcript plainly isn't about this property (another job, a personal call, something playing in the background), leave it out of the notes.",
    prompt: `From this transcript of Hunter's scope walk, pull out what an estimator needs to write the scope.\n\n${transcript.slice(0, 200_000)}`,
    schema: SCHEMA,
  });
  const n = (notes ?? {}) as Partial<WalkNotes>;
  return { summary: n.summary ?? "", rooms: n.rooms ?? [], measurements: n.measurements ?? [], customerWants: n.customerWants ?? [], promises: n.promises ?? [], address: n.address, names: n.names, transcript, leftOut: leftOut.length ? leftOut : undefined };
}

/** Which job a recording belongs to: the calendar visit at that time, else the address or names said in it. */
export async function matchWalk(hub: Hub, at: Date, notes: Pick<WalkNotes, "address" | "names" | "transcript">): Promise<{ jobNumber?: number; why?: string; candidates: { jobNumber: number; name: string }[] }> {
  const jobs = hub.jobs.list();
  const byNum = new Map(jobs.map((j) => [j.jobNumber, j]));
  // 1. A calendar event for a job around that time (the walk can start early or run long).
  if (hub.calendar.connected()) {
    const ev = await myEvents(hub, { start: new Date(at.getTime() - 3 * 3600e3).toISOString(), end: new Date(at.getTime() + 3 * 3600e3).toISOString() }).catch(() => []);
    const near = ev
      .filter((e) => !e.allDay)
      .map((e) => {
        const street = (e.location ?? "").split(",")[0].trim().toLowerCase();
        // The event names the job: "#3184", its address, or the job's name in the title ("Sanders walk").
        const title = ` ${e.title.toLowerCase()} `;
        const named = jobs.filter((j) => j.name.trim().length >= 4 && new RegExp(`\\b${j.name.trim().toLowerCase().replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`).test(title));
        const job = e.jobNumber && byNum.has(e.jobNumber) ? e.jobNumber : (street.length >= 6 ? jobs.find((j) => j.address.toLowerCase().startsWith(street))?.jobNumber : undefined) ?? (named.length === 1 ? named[0].jobNumber : undefined);
        const gap = at.getTime() < Date.parse(e.start) ? Date.parse(e.start) - at.getTime() : at.getTime() > Date.parse(e.end) ? at.getTime() - Date.parse(e.end) : 0;
        return { job, gap, title: e.title };
      })
      .filter((x) => x.job && x.gap <= 90 * 60e3)
      .sort((a, b) => a.gap - b.gap);
    const distinct = [...new Set(near.map((x) => x.job!))];
    if (distinct.length === 1 || (near[0] && near[0].gap === 0 && near.filter((x) => x.gap === 0).length === 1)) return { jobNumber: near[0].job, why: `calendar: ${near[0].title}`, candidates: [] };
    if (distinct.length > 1) return { candidates: distinct.map((n) => ({ jobNumber: n, name: byNum.get(n)!.name })) };
  }
  // 2. What's said: the street address, or a customer's last name.
  const text = `${notes.address ?? ""} ${(notes.names ?? []).join(" ")} ${notes.transcript.slice(0, 4000)}`.toLowerCase();
  const hits = jobs.filter((j) => {
    const street = j.address.split(",")[0].trim().toLowerCase();
    const last = (j.customer.attention || j.customer.name).split(/\s+/).at(-1)?.toLowerCase() ?? "";
    return (street.length >= 6 && text.includes(street)) || (last.length >= 4 && (notes.names ?? []).some((n) => n.toLowerCase().split(/\s+/).includes(last)));
  });
  if (hits.length === 1) return { jobNumber: hits[0].jobNumber, why: "from what's said in the recording", candidates: [] };
  return { candidates: hits.slice(0, 4).map((j) => ({ jobNumber: j.jobNumber, name: j.name })) };
}

/** How many times a recording has hit a "try again later" error since Keystone started. */
const retries = new Map<string, number>();

const holding = (hub: Hub) => path.join(hub.cfg.stateDir, "walks");
const stamp = (d: Date) => `${d.toLocaleDateString("en-CA", { timeZone: "America/Denver" })} ${d.toLocaleTimeString("en-GB", { timeZone: "America/Denver", hour: "2-digit", minute: "2-digit" }).replace(":", "")}`;

export function walkMarkdown(w: { recordedAt: string; name: string }, n: WalkNotes): string {
  const list = (xs: string[]) => (xs.length ? xs.map((x) => `- ${x}`).join("\n") : "- (none)");
  return `# Scope walk recording, ${new Date(w.recordedAt).toLocaleString("en-US", { timeZone: "America/Denver", weekday: "long", month: "long", day: "numeric", year: "numeric", hour: "numeric", minute: "2-digit" })}

Source: ${w.name} (recorded on Hunter's watch; transcribed by Gemini, so check anything that matters against the audio).

## Summary
${n.summary}

## By room
${n.rooms.length ? n.rooms.map((r) => `- **${r.room}**: ${r.notes}`).join("\n") : "- (none)"}

## Measurements said out loud
${list(n.measurements)}

## What the customer wants
${list(n.customerWants)}

## What Hunter said he'd do
${list(n.promises.map((p) => `${p.what}${p.due ? ` (by ${p.due})` : ""}`))}

## Transcript
${n.transcript}
${n.leftOut?.length ? `\n## Left out (not part of the walk)\n${list(n.leftOut)}\n` : ""}`;
}

/** Puts a processed recording in its job: the notes and a copy of the audio in notes/walks/. */
function fileToJob(hub: Hub, w: Walk, md: string): Walk {
  const n = w.jobNumber!;
  const dir = hub.jobs.path(n, "notes", "walks");
  mkdirSync(dir, { recursive: true });
  const base = `${stamp(new Date(w.recordedAt))} walk`;
  writeFileSync(path.join(dir, `${base}.md`), md);
  if (existsSync(w.file)) copyFileSync(w.file, path.join(dir, `${base}${path.extname(w.file).toLowerCase()}`));
  hub.jobs.log(n, `Walk recording filed: ${w.summary?.slice(0, 120) ?? w.name}`);
  return { ...w, status: "filed", notesFile: `notes/walks/${base}.md`, candidates: undefined };
}

/**
 * Looks for new recordings and processes each once. Returns what's new. Recordings still being written (changed in
 * the last minute) wait for the next pass.
 */
export async function scanWalks(hub: Hub, opts: { now?: Date; transcriber?: (file: string) => Promise<WalkNotes>; /** Process just this file, even if it's from before set-up. */ only?: string; /** With `only`: transcribe it again even though it's been done, keeping the job it's filed to. */ redo?: boolean } = {}): Promise<Walk[]> {
  const st = walksStatus(hub);
  if (!st.on) return [];
  const now = opts.now ?? new Date();
  const list = walks(hub);
  const seen = new Set(list.map((w) => w.id));
  const fresh: Walk[] = [];
  const files = readdirSync(st.dir, { recursive: true, withFileTypes: true }).filter((d) => d.isFile() && AUDIO.test(d.name)).map((d) => path.join(d.parentPath ?? (d as any).path ?? st.dir, d.name));
  for (const file of files) {
    const s = statSync(file);
    const id = `${path.basename(file)}:${s.size}`;
    if (opts.only && path.basename(file) !== opts.only) continue;
    const old = opts.only && opts.redo ? list.find((x) => x.id === id) : undefined;
    if ((seen.has(id) && !old) || skipReason(hub, s, now, !!opts.only)) continue;
    const at = recordedAt(path.basename(file), s.mtime);
    let w: Walk = { id, file, name: path.basename(file), recordedAt: at.toISOString(), status: "error", processedAt: now.toISOString() };
    try {
      hub.say(`Walk recording: transcribing ${w.name}…`);
      const notes = await (opts.transcriber ?? ((f) => transcribe(hub, f)))(file);
      if (!notes?.transcript?.trim()) throw new Error("Nothing could be heard in that recording.");
      // One speaker turn per line, however the AI laid it out.
      notes.transcript = notes.transcript.replace(/([.?!\]])\s+(?=(?:Hunter|Customer|Note|Adjuster|[A-Z][a-z]+):\s)/g, "$1\n");
      const md = walkMarkdown(w, notes);
      const m = old?.jobNumber && hub.jobs.exists(old.jobNumber) ? { jobNumber: old.jobNumber, why: old.why ?? "kept on its job", candidates: [] } : await matchWalk(hub, at, notes);
      w = { ...w, summary: notes.summary, promises: notes.promises, jobNumber: m.jobNumber, why: m.why, candidates: m.candidates };
      if (m.jobNumber) {
        w = fileToJob(hub, w, md);
        hub.say(`Walk recording filed to #${m.jobNumber} ${hub.jobs.get(m.jobNumber).name} (${m.why}).`);
      } else {
        mkdirSync(holding(hub), { recursive: true });
        const keep = path.join(holding(hub), `${stamp(at)} ${path.basename(file)}.md`);
        writeFileSync(keep, md);
        w = { ...w, status: "needs-job", notesFile: keep };
        hub.say(`Walk recording transcribed, but I couldn't tell which job it's for: pick one on the dashboard.`);
      }
    } catch (e) {
      const msg = (e as Error).message;
      // Gemini busy or the connection dropped: leave it for the next sync (up to 6 tries) instead of giving up.
      const tries = (retries.get(id) ?? 0) + 1;
      retries.set(id, tries);
      if (BUSY_RX.test(msg) && tries < 6) {
        hub.say(`Walk recording ${w.name}: Gemini is busy right now; Keystone will try it again at the next sync (try ${tries} of 5).`);
        continue;
      }
      w = { ...w, status: "error", error: msg };
      hub.say(`Walk recording ${w.name}: ${msg}`);
    }
    if (old) list.splice(list.indexOf(old), 1);
    list.push(w);
    fresh.push(w);
    save(hub, list);
  }
  return fresh;
}

/** Why a recording in the folder isn't being transcribed (or "" when it will be). */
function skipReason(hub: Hub, s: { size: number; mtimeMs: number }, now: Date, forced = false): string {
  if (s.size < 20_000) return "Too short (a few seconds): skipped as accidental.";
  if (now.getTime() - s.mtimeMs < 60_000) return "Just arrived: it's picked up at the next sync.";
  // Only recordings made after this was set up (the folder may hold years of voice memos).
  if (!forced && hub.cfg.walks.since && s.mtimeMs < Date.parse(hub.cfg.walks.since)) return "Recorded before walk recordings were connected. Press Transcribe to do it anyway.";
  return "";
}

/** Everything in the recordings folder, newest first, with what happened to each (for the Walks page). */
export function walkFolder(hub: Hub, now = new Date()): { name: string; at: string; sizeMb: number; walk?: Walk; waiting?: string }[] {
  const st = walksStatus(hub);
  if (!st.on) return [];
  const list = walks(hub);
  const files = readdirSync(st.dir, { recursive: true, withFileTypes: true }).filter((d) => d.isFile() && AUDIO.test(d.name)).map((d) => path.join(d.parentPath ?? (d as any).path ?? st.dir, d.name));
  return files
    .map((file) => {
      const s = statSync(file);
      const walk = list.find((w) => w.id === `${path.basename(file)}:${s.size}`);
      return { name: path.basename(file), at: (walk ? new Date(walk.recordedAt) : recordedAt(path.basename(file), s.mtime)).toISOString(), sizeMb: Math.round(s.size / 104857.6) / 10, walk, waiting: walk ? undefined : skipReason(hub, s, now) || "Waiting for the next sync." };
    })
    .sort((a, b) => b.at.localeCompare(a.at))
    .slice(0, 200);
}

/** A recording's notes (summary, rooms, transcript) as written to the job folder or the holding folder. */
export function walkNotesText(hub: Hub, id: string): string {
  const w = walks(hub).find((x) => x.id === id);
  if (!w?.notesFile) return "";
  const f = w.status === "filed" && w.jobNumber ? path.join(hub.jobs.folder(w.jobNumber), w.notesFile) : w.notesFile;
  return existsSync(f) ? readFileSync(f, "utf8") : "";
}

/** Moves a filed recording to a different job (it was matched to the wrong one). */
export function refileWalk(hub: Hub, id: string, jobNumber: number): Walk {
  const list = walks(hub);
  const i = list.findIndex((w) => w.id === id);
  if (i < 0) throw new Error("That recording isn't in the list any more.");
  const w = list[i];
  if (w.status === "needs-job") return fileWalk(hub, id, jobNumber);
  if (w.status !== "filed" || !w.jobNumber || !w.notesFile) throw new Error("That recording hasn't been transcribed yet.");
  if (!hub.jobs.exists(jobNumber)) throw new Error(`There's no job folder for #${jobNumber}.`);
  if (w.jobNumber === jobNumber) return w;
  const from = path.join(hub.jobs.folder(w.jobNumber), w.notesFile);
  const md = readFileSync(from, "utf8");
  const moved = fileToJob(hub, { ...w, jobNumber, why: "you picked the job" }, md);
  for (const f of [from, from.replace(/\.md$/, path.extname(w.file).toLowerCase())]) if (existsSync(f)) rmSync(f);
  hub.jobs.log(w.jobNumber, `Walk recording moved to #${jobNumber}`);
  list[i] = moved;
  save(hub, list);
  return moved;
}

/** Files a recording that was waiting for a job (picked on the dashboard). */
export function fileWalk(hub: Hub, id: string, jobNumber: number): Walk {
  const list = walks(hub);
  const i = list.findIndex((w) => w.id === id);
  if (i < 0) throw new Error("That recording isn't in the list any more.");
  if (!hub.jobs.exists(jobNumber)) throw new Error(`There's no job folder for #${jobNumber}.`);
  const w = list[i];
  if (w.status !== "needs-job" || !w.notesFile || !existsSync(w.notesFile)) throw new Error("That recording is already filed.");
  list[i] = fileToJob(hub, { ...w, jobNumber, why: "you picked the job" }, readFileSync(w.notesFile, "utf8"));
  save(hub, list);
  return list[i];
}

/** Tries a recording again (after an error), or drops one from the list (`forget`). */
export function retryWalk(hub: Hub, id: string, forget = false) {
  const list = walks(hub);
  const w = list.find((x) => x.id === id);
  if (!w) return;
  // Forgotten ones stay in the list (so they aren't picked up again) but out of sight.
  if (forget) save(hub, list.map((x) => (x.id === id ? { ...x, status: "filed" as const, jobNumber: undefined, candidates: undefined, error: undefined, summary: "(dismissed)" } : x)));
  else save(hub, list.filter((x) => x.id !== id));
}

/** A job's walk notes, newest first (for the timeline and the Estimator's inputs). */
export function jobWalks(hub: Hub, n: number): { file: string; at: string; summary: string }[] {
  const dir = hub.jobs.path(n, "notes", "walks");
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f) => f.endsWith(".md"))
    .map((f) => {
      const text = readFileSync(path.join(dir, f), "utf8");
      const w = walks(hub).find((x) => x.jobNumber === n && x.notesFile === `notes/walks/${f}`);
      return { file: `notes/walks/${f}`, at: w?.recordedAt ?? statSync(path.join(dir, f)).mtime.toISOString(), summary: text.match(/## Summary\n([\s\S]*?)\n\n## /)?.[1]?.trim() ?? "" };
    })
    .sort((a, b) => b.at.localeCompare(a.at));
}

/**
 * After a recording is filed: offers a short note for the job's Homebase feed (editable), and Google Tasks for what
 * Hunter said he'd do. Both ask first; nothing is written without a yes.
 */
/** Stages a job is in before its first scope walk. A walk recorded from one of these was the initial walk. */
export const BEFORE_WALK = new Set(["Qualify", "Lead", "Scope Walk"]);

/**
 * The initial scope walk is done once its recording is filed, so the job moves on to Estimating in Homebase
 * (after a Yes, like every Homebase change). A job already past that point is left where it is.
 */
export async function offerEstimatingStage(hub: Hub, w: Walk): Promise<boolean> {
  if (w.status !== "filed" || !w.jobNumber) return false;
  const n = w.jobNumber;
  const from = (await hub.homebase.getJob(n).then((j) => j.stage).catch(() => "")) || hub.jobs.get(n).stage;
  if (!BEFORE_WALK.has(from)) return false;
  const name = hub.jobs.get(n).name;
  if (!(await hub.approver.confirm(`Move #${n} ${name} from ${from} to Estimating in Homebase?`, ["The scope walk is done: its recording was just filed to the job."]))) return false;
  await hub.homebase.setStage(n, "Estimating", from);
  hub.jobs.upsert(n, { stage: "Estimating", stageSince: new Date().toISOString() });
  hub.jobs.log(n, `Homebase: stage ${from} -> Estimating (scope walk recorded)`);
  hub.say(`Moved #${n} ${name} to Estimating in Homebase.`);
  return true;
}

export async function offerWalkFollowups(hub: Hub, w: Walk): Promise<void> {
  if (w.status !== "filed" || !w.jobNumber) return;
  await offerEstimatingStage(hub, w).catch((e) => hub.say(`Couldn't move #${w.jobNumber} to Estimating: ${(e as Error).message}`));
  if (!w.summary) return;
  const n = w.jobNumber;
  const day = new Date(w.recordedAt).toLocaleDateString("en-US", { timeZone: "America/Denver", weekday: "short", month: "short", day: "numeric" });
  const note = await confirmText(hub.approver, `Add this scope walk summary to Homebase #${n}?`, ["From your walk recording. Edit it if you like."], `Scope walk ${day}: ${w.summary}`);
  if (note) {
    await hub.homebase.addNote(n, { kind: "note", body: note });
    hub.jobs.log(n, `Homebase note: ${note.slice(0, 120)}`);
    hub.say(`Added the walk summary to Homebase #${n}.`);
  }
  const promises = (w.promises ?? []).filter((p) => p.what.trim()).slice(0, 8);
  if (promises.length && hub.tasks.connected()) {
    const titles = promises.map((p) => `${p.what.trim().replace(/\.$/, "")}${p.due ? ` (said: ${p.due})` : ""} #${n}`);
    if (await hub.approver.confirm(`Add ${titles.length === 1 ? "this task" : `these ${titles.length} tasks`} to Google Tasks? (things you said you'd do on the walk)`, titles)) {
      for (const title of titles) await hub.tasks.create({ title });
      hub.say(`Added ${titles.length} task${titles.length === 1 ? "" : "s"} from the walk.`);
    }
  }
}
