import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { complete } from "../agent/llm.js";
import type { Hub } from "../hub.js";

/**
 * Reading done ahead of time by the free AI (Gemini), so the paid one doesn't have to: the job's emails and texts
 * boiled down to what was asked for, agreed, ruled out and measured (each point with its date, who said it and
 * where to find the original), and a line about every photo (which room, what it shows) next to numbered contact
 * sheets saved in photos/sheets. The estimator reads these first and opens an original only where a detail matters.
 * Both are kept on disk and only redone when the emails, texts or photos change. If Gemini isn't available, or
 * fails, the caller simply gets the originals as before.
 */
export interface Point {
  when: string;
  who: string;
  kind: "asked" | "agreed" | "ruled_out" | "measurement" | "material" | "deadline" | "access" | "info";
  text: string;
  /** "email <threadId>" or "text" or "call": where the exact words are. */
  source: string;
}
export interface ConversationDigest {
  summary: string;
  points: Point[];
}
export interface PhotoNotes {
  /** Contact sheets, relative to the job folder ("photos/sheets/sheet_01.jpg"), 12 numbered photos each. */
  sheets: string[];
  photos: { number: number; file: string; sheet: string; room: string; shows: string }[];
}

const hash = (x: unknown) => createHash("sha1").update(JSON.stringify(x)).digest("hex").slice(0, 16);
function cached<T>(file: string, key: string): T | null {
  try {
    const j = JSON.parse(readFileSync(file, "utf8"));
    return j.key === key ? (j.value as T) : null;
  } catch {
    return null;
  }
}
function keep(file: string, key: string, value: unknown) {
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify({ key, at: new Date().toISOString(), value }, null, 1));
}

export interface Said {
  kind: "email" | "text" | "call";
  at: string;
  who: string;
  subject?: string;
  body: string;
  threadId?: string;
}

/** Worth digesting only when there's enough to read that it would cost real money to send whole. */
export const DIGEST_MIN_CHARS = 5000;

export async function conversationDigest(hub: Hub, n: number, said: Said[]): Promise<ConversationDigest | null> {
  if (!hub.gemini || !hub.cfg.ai.geminiKey || said.reduce((t, x) => t + x.body.length, 0) < DIGEST_MIN_CHARS) return null;
  const file = hub.jobs.path(n, "notes", "job-digest.json");
  const key = hash(said.map((x) => [x.kind, x.at, x.who, x.body.length]));
  const hit = cached<ConversationDigest>(file, key);
  if (hit) return hit;
  try {
    const out = await complete<ConversationDigest>(hub, {
      system: `You prepare a reconstruction estimator's reading. From the emails, texts and calls on one job, pull out every point that bears on the scope of work, the price, the schedule or access, so the estimator doesn't have to read them all. Keep the speaker's meaning exactly; quote numbers, measurements, materials, colors and dates as written. Leave out greetings, scheduling chatter that's already past, signatures and anything not about this job. Do not interpret, recommend or fill gaps. If two messages disagree, include both.`,
      prompt: `Job #${n}. Messages, oldest first. Each starts with [kind date who (thread id)].\n\n${said.map((x) => `[${x.kind} ${x.at.slice(0, 10)} ${x.who}${x.threadId ? ` (thread ${x.threadId})` : ""}] ${x.subject ? `${x.subject}: ` : ""}${x.body}`).join("\n\n").slice(0, 300_000)}`,
      schema: {
        type: "object",
        properties: {
          summary: { type: "string", description: "Four to eight sentences: who is involved, what was asked for, what was agreed or ruled out, anything still open." },
          points: {
            type: "array",
            items: {
              type: "object",
              properties: {
                when: { type: "string", description: "the message's date, YYYY-MM-DD" },
                who: { type: "string" },
                kind: { type: "string", enum: ["asked", "agreed", "ruled_out", "measurement", "material", "deadline", "access", "info"] },
                text: { type: "string", description: "the point in one sentence, with exact numbers and names" },
                source: { type: "string", description: "\"email <thread id>\", \"text\" or \"call\"" },
              },
              required: ["when", "who", "kind", "text", "source"],
            },
          },
        },
        required: ["summary", "points"],
      },
    });
    if (!out?.summary) return null;
    const value = { summary: out.summary, points: (out.points ?? []).slice(0, 120) };
    keep(file, key, value);
    return value;
  } catch {
    return null; // the caller sends the originals instead
  }
}

const IMAGE = /\.(jpe?g|png|webp)$/i;
function photoFiles(dir: string, base = "", out: string[] = []): string[] {
  if (!existsSync(dir)) return out;
  for (const f of readdirSync(dir).sort()) {
    const full = path.join(dir, f), rel = base ? `${base}/${f}` : f;
    if (rel === "sheets") continue;
    if (statSync(full).isDirectory()) photoFiles(full, rel, out);
    else if (IMAGE.test(f)) out.push(rel);
  }
  return out;
}

/** Numbered contact sheets for the job's photos, with a line about each photo. Redone only when the photos change. */
export async function photoNotes(hub: Hub, n: number): Promise<PhotoNotes | null> {
  if (!hub.gemini || !hub.cfg.ai.geminiKey) return null;
  const photosDir = hub.jobs.path(n, "photos");
  const all = photoFiles(photosDir);
  if (!all.length) return null;
  // CompanyCam's previews first (they carry descriptions), then anything else; 96 photos (8 sheets) at most.
  const files = [...all.filter((f) => f.startsWith("previews/")), ...all.filter((f) => !f.startsWith("previews/"))].slice(0, 96);
  const sheetsDir = path.join(photosDir, "sheets"), file = path.join(sheetsDir, "photo-notes.json");
  const key = hash(files.map((f) => [f, statSync(path.join(photosDir, f)).size]));
  const hit = cached<PhotoNotes>(file, key);
  if (hit && hit.sheets.every((s) => existsSync(path.join(hub.jobs.folder(n), s)))) return hit;
  try {
    rmSync(sheetsDir, { recursive: true, force: true });
    mkdirSync(sheetsDir, { recursive: true });
    const r = await hub.skill.run("photo_sheets.py", [...files.map((f) => path.join(photosDir, f)), "--out", sheetsDir]);
    if (r.code !== 0) return null;
    const skipped = new Set([...r.stderr.matchAll(/^! skipped (.+?):/gm)].map((m) => m[1]));
    const numbered = files.filter((f) => !skipped.has(path.basename(f)));
    const sheets = readdirSync(sheetsDir).filter((f) => /^sheet_\d+\.jpg$/.test(f)).sort();
    if (!sheets.length) return null;
    let index: { file: string; description?: string }[] = [];
    try { index = JSON.parse(readFileSync(path.join(photosDir, "previews", "index.json"), "utf8")); } catch { index = []; }
    const about = new Map(index.map((p) => [`previews/${p.file}`, p.description || ""]));
    const out = await complete<{ photos: { number: number; room: string; shows: string }[] }>(hub, {
      system: `You look at job-site photos for a reconstruction estimator (water, fire and mold repairs) and write one plain line about each, so the estimator knows which photos to open. Say only what is visible: the room or area if you can tell (else "unknown"), and what the photo shows that matters for repairs (damage, what was removed, materials and finishes, a reading on a meter, a measurement, a label). No guesses about cause, no recommendations.`,
      prompt: `Job #${n}. The attached contact sheets show ${numbered.length} photos numbered #1 to #${numbered.length}, 12 to a sheet, in order. What CompanyCam says about some of them: ${JSON.stringify(numbered.map((f, i) => ({ number: i + 1, description: about.get(f) || undefined })).filter((x) => x.description))}\nGive every photo's number, room and what it shows.`,
      images: sheets.map((f) => ({ mimeType: "image/jpeg", data: readFileSync(path.join(sheetsDir, f)).toString("base64") })),
      schema: { type: "object", properties: { photos: { type: "array", items: { type: "object", properties: { number: { type: "integer" }, room: { type: "string" }, shows: { type: "string" } }, required: ["number", "room", "shows"] } } }, required: ["photos"] },
    });
    const said = new Map((out?.photos ?? []).map((p) => [p.number, p]));
    const value: PhotoNotes = {
      sheets: sheets.map((f) => `photos/sheets/${f}`),
      photos: numbered.map((f, i) => ({ number: i + 1, file: `photos/${f}`, sheet: `photos/sheets/${sheets[Math.floor(i / 12)] ?? sheets.at(-1)}`, room: said.get(i + 1)?.room ?? "unknown", shows: said.get(i + 1)?.shows ?? about.get(f) ?? "" })),
    };
    if (!said.size) return null;
    keep(file, key, value);
    return value;
  } catch {
    return null;
  }
}
