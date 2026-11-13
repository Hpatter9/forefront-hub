import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { runPython } from "../agent/geminiEstimator.js";
import { complete } from "../agent/llm.js";
import type { Hub } from "../hub.js";
import { savedNotes } from "./pull.js";

/**
 * The sub work order: one PDF a subcontractor can work from. Room by room it says what to do and how much, which
 * walls, ceilings and trim get painted, and shows photos of the areas, with no prices anywhere. It's written by
 * the everyday AI (Gemini, free) from what's already on the job: the estimate's line items (prices taken out
 * first), the scope walk transcripts, Hunter's and the team's notes, and the job's photos. Anything those sources
 * don't settle (most often WHICH walls) is listed as a question for Hunter and printed on the sheet as "not
 * settled", instead of being guessed. Layout: scripts/sub_report.py.
 */
export interface SubOrder {
  job_number: number;
  customer: string;
  address: string;
  date: string;
  trade: string;
  contact: { name: string; phone: string };
  summary: string;
  access: string;
  general: string[];
  rooms: {
    room: string;
    work: { trade: string; task: string; qty: string }[];
    paint: { walls: string; ceiling: string; trim: string; color: string; prep: string } | null;
    notes: string[];
    photos: { file: string; caption: string }[];
  }[];
  questions: string[];
}

const IMAGE = /\.(jpe?g|png|webp)$/i;
const MONEY = /price|total|amount|cost|markup|overhead|profit|tax|subtotal|rcv|acv|deprec|o&p|billing|deposit|allowance/i;

/** The estimate with every price, total and percentage taken out: what's left is rooms, items and quantities. */
export function withoutPrices(x: unknown): unknown {
  if (Array.isArray(x)) return x.map(withoutPrices);
  if (x && typeof x === "object") return Object.fromEntries(Object.entries(x as Record<string, unknown>).filter(([k]) => !MONEY.test(k)).map(([k, v]) => [k, withoutPrices(v)]));
  return x;
}

const read = (f: string, max = 60_000) => { try { return existsSync(f) ? readFileSync(f, "utf8").slice(0, max) : ""; } catch { return ""; } };

function photoFiles(dir: string, base = "", out: string[] = []): string[] {
  if (!existsSync(dir)) return out;
  for (const f of readdirSync(dir).sort()) {
    const full = path.join(dir, f), rel = base ? `${base}/${f}` : f;
    if (statSync(full).isDirectory()) photoFiles(full, rel, out);
    else if (IMAGE.test(f) && !/^sheet_\d+\.jpg$/.test(f)) out.push(rel);
  }
  return out;
}

const SCHEMA = {
  type: "object",
  properties: {
    summary: { type: "string", description: "Two or three sentences a sub reads first: what happened and what the repair is." },
    access: { type: "string", description: "How to get in, as the sources say (lockbox, occupied, hours, pets). Empty if they don't say." },
    general: { type: "array", items: { type: "string" }, description: "Job-wide instructions from the sources: floor protection, dust control, where debris goes, what the owner asked for." },
    rooms: {
      type: "array",
      items: {
        type: "object",
        properties: {
          room: { type: "string" },
          work: { type: "array", items: { type: "object", properties: { trade: { type: "string", description: "Demo, Drywall, Paint, Flooring, Trim, Tile, Cabinets, Plumbing, Electrical, Insulation, Cleaning, Other" }, task: { type: "string", description: "One plain instruction: what to do and exactly where in the room." }, qty: { type: "string", description: "Quantity with its unit from the estimate (\"40 SF\", \"26 LF\", \"1 EA\"); empty if none." } }, required: ["trade", "task"] } },
          paint: {
            type: "object",
            description: "Only when this room has painting in the scope.",
            properties: {
              walls: { type: "string", description: "Exactly which walls, described so someone standing in the room can't get it wrong (\"all four walls\", \"the tub wall and the wall with the window only\"). If the sources don't say which walls, write exactly: NOT SETTLED" },
              ceiling: { type: "string", description: "\"Yes, whole ceiling\", \"No\", a part of it, or NOT SETTLED" },
              trim: { type: "string", description: "Baseboard, casing, doors, with quantities; or \"None\"" },
              color: { type: "string", description: "Color and sheen if the sources give them; otherwise \"Match existing\" only if the sources say to match, else NOT SETTLED" },
              prep: { type: "string", description: "Seal stains, prime new drywall, mask, and so on, from the estimate's items" },
            },
            required: ["walls", "ceiling", "trim", "color", "prep"],
          },
          notes: { type: "array", items: { type: "string" }, description: "Things about this room a sub needs: what stays, what to protect, what the customer wants." },
          photos: { type: "array", items: { type: "object", properties: { number: { type: "integer", description: "The photo's number on the contact sheets" }, caption: { type: "string", description: "What it shows and why it matters for the work, one line" } }, required: ["number", "caption"] }, description: "Up to 3 photos that show the area to work on in this room." },
        },
        required: ["room", "work", "notes", "photos"],
      },
    },
    questions: { type: "array", items: { type: "string" }, description: "Everything a sub would need that the sources don't settle, each as one question for Hunter, naming the room." },
  },
  required: ["summary", "access", "general", "rooms", "questions"],
};

export interface SubReportResult {
  file: string;
  questions: string[];
  rooms: number;
  photos: number;
  model?: string;
}

export async function makeSubReport(hub: Hub, n: number, o: { trade?: string } = {}): Promise<SubReportResult> {
  const job = hub.jobs.get(n);
  const trade = (o.trade ?? "").trim();
  const estFile = hub.jobs.path(n, "estimate", "estimate.json");
  let estimate: unknown = null;
  try { estimate = existsSync(estFile) ? withoutPrices(JSON.parse(readFileSync(estFile, "utf8"))) : null; } catch { estimate = null; }
  const walksDir = hub.jobs.path(n, "notes", "walks");
  const walks = existsSync(walksDir) ? readdirSync(walksDir).filter((f) => f.endsWith(".md")).sort().map((f) => read(path.join(walksDir, f), 50_000)) : [];
  const notes = read(hub.jobs.path(n, "notes", "notes.txt"), 12_000);
  const team = savedNotes(hub, n).flatMap((x) => [x, ...x.replies]).map((x) => `${x.author}: ${x.body}`).slice(0, 40).join("\n").slice(0, 12_000);
  if (!estimate && !walks.length && !notes.trim()) throw new Error(`There's nothing to build a work order from on #${n} yet: no estimate, no walk recording and no notes.`);

  // The photos, numbered on contact sheets (the skill's own photo_sheets.py), so Gemini can point at them.
  const photosDir = hub.jobs.path(n, "photos");
  const all = photoFiles(photosDir);
  // CompanyCam previews first (they have descriptions), then whatever else is in the folder; 96 at most (8 sheets).
  const files = [...all.filter((f) => f.startsWith("previews/")), ...all.filter((f) => !f.startsWith("previews/"))].slice(0, 96);
  let numbered: string[] = [], sheets: { mimeType: string; data: string }[] = [];
  const tmp = mkdtempSync(path.join(os.tmpdir(), "keystone-sub-"));
  try {
    if (files.length) {
      const r = await hub.skill.run("photo_sheets.py", [...files.map((f) => path.join(photosDir, f)), "--out", tmp]).catch((e) => ({ code: 1, stdout: "", stderr: (e as Error).message }));
      if (r.code === 0) {
        const skipped = new Set([...r.stderr.matchAll(/^! skipped (.+?):/gm)].map((m) => m[1]));
        numbered = files.filter((f) => !skipped.has(path.basename(f)));
        sheets = readdirSync(tmp).filter((f) => /^sheet_\d+\.jpg$/.test(f)).sort().slice(0, 8).map((f) => ({ mimeType: "image/jpeg", data: readFileSync(path.join(tmp, f)).toString("base64") }));
      } else hub.say("The photos couldn't be laid out for the work order, so it's being written without them.");
    }
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
  let index: { file: string; description?: string }[] = [];
  try { index = JSON.parse(read(path.join(photosDir, "previews", "index.json"), 400_000) || "[]"); } catch { index = []; }
  const about = new Map(index.map((p) => [`previews/${p.file}`, p.description || ""]));

  const used = new Set<string>();
  const out = await complete<Omit<SubOrder, "job_number" | "customer" | "address" | "date" | "trade" | "contact" | "rooms"> & { rooms: (Omit<SubOrder["rooms"][number], "photos"> & { photos: { number: number; caption: string }[] })[] }>(hub, {
    system: `You write work orders for Forefront Building + Restoration's subcontractors (reconstruction after water, fire and mold damage). A sub reads it on site and does exactly what it says, so it has to be specific and it has to be true.

Rules:
- Use ONLY what is in the sources below: the estimate's line items, the scope walk transcripts, the notes and the photos. Never add work, a wall, a color or a quantity that isn't there.
- NO prices, totals, percentages or dollar amounts, anywhere.
- Write each task as a plain instruction saying what to do and where in the room ("Remove and replace baseboard on all walls", "Hang and finish drywall on the lower 4 ft of the wall behind the vanity"). Carry the estimate's quantity and unit into "qty".
- Painting is where subs go wrong, so be exact about WHICH walls and whether the ceiling is included. Work it out from the sources: the transcript and notes (what Hunter said on the walk), the estimate's wall and ceiling quantities compared with the room's size, and the photos. Describe walls the way someone standing in the room would know them (the tub wall, the wall with the window, the wall shared with the hallway), not by compass direction unless the sources use it.
- If the sources do not settle something a sub needs (which walls, the color, how far a repair goes), do not guess. Write NOT SETTLED in that field and add a question for Hunter to "questions", naming the room.
- Photos: for each room pick up to 3 photos, by their number on the contact sheets, that show the area to be worked on. The caption says what to look at. Don't pick a photo you can't place in a room.
${trade ? `- This copy is for the ${trade} only: include just the rooms and tasks that trade does, plus anything they must know to do it (what another trade does first, what to protect). Leave other trades' work out.` : "- This copy is for all trades: group each room's tasks by trade."}`,
    prompt: `Job #${n} ${job.name}, ${job.address}.

THE ESTIMATE (prices removed):
${estimate ? JSON.stringify(estimate).slice(0, 120_000) : "(There is no estimate yet. Build the work order from the walk and the notes, and say so in the summary.)"}

SCOPE WALK TRANSCRIPTS (what Hunter said and heard on site):
${walks.join("\n\n---\n\n") || "(none)"}

HUNTER'S JOB NOTES:
${notes || "(none)"}

TEAM NOTES FROM HOMEBASE:
${team || "(none)"}

PHOTOS: ${numbered.length ? `the attached contact sheets show ${numbered.length} photos, numbered #1 to #${numbered.length}. What's known about them: ${JSON.stringify(numbered.map((f, i) => ({ number: i + 1, folder: path.dirname(f) === "." ? "" : path.dirname(f), description: about.get(f) || undefined })))}` : "(no photos on the job)"}`,
    images: sheets,
    schema: SCHEMA,
    used,
  });
  if (!out?.rooms?.length) throw new Error("Gemini couldn't put a work order together from what's on the job. Try again in a minute, or add walk notes or an estimate first.");

  const company = (() => { try { return JSON.parse(readFileSync(path.join(hub.cfg.skillDir, "assets", "company.json"), "utf8")); } catch { return {}; } })();
  const unsettled = (s: string) => /NOT SETTLED/i.test(s || "");
  const order: SubOrder = {
    job_number: n, customer: job.name, address: job.address, date: new Date().toLocaleDateString("en-CA", { timeZone: "America/Denver" }), trade,
    contact: { name: hub.cfg.homebase.me, phone: company.phone ?? "" },
    summary: out.summary ?? "", access: out.access ?? "", general: out.general ?? [],
    rooms: out.rooms.map((r) => {
      const seen = new Set<string>();
      return {
        room: r.room, notes: r.notes ?? [],
        work: (r.work ?? []).map((w) => ({ trade: w.trade ?? "", task: w.task ?? "", qty: w.qty ?? "" })),
        paint: r.paint ? { walls: r.paint.walls ?? "", ceiling: r.paint.ceiling ?? "", trim: r.paint.trim ?? "", color: r.paint.color ?? "", prep: r.paint.prep ?? "" } : null,
        photos: (r.photos ?? []).map((p) => ({ file: numbered[p.number - 1], caption: p.caption ?? "" })).filter((p) => p.file && !seen.has(p.file) && seen.add(p.file)).slice(0, 3),
      };
    }),
    questions: [...(out.questions ?? [])],
  };
  // Anything marked NOT SETTLED must also be a question, so it can't be missed.
  for (const r of order.rooms) {
    if (r.paint) for (const [k, label] of [["walls", "which walls get painted"], ["ceiling", "whether the ceiling gets painted"], ["color", "the paint color and sheen"]] as const) {
      if (unsettled(r.paint[k]) && !order.questions.some((q) => q.toLowerCase().includes(r.room.toLowerCase()) && new RegExp(k === "color" ? "color|sheen" : k.replace(/s$/, ""), "i").test(q))) order.questions.push(`${r.room}: ${label}?`);
      if (unsettled(r.paint[k])) r.paint[k] = "NOT SETTLED: check with Forefront before painting";
    }
  }

  const dir = hub.jobs.path(n, "estimate");
  mkdirSync(dir, { recursive: true });
  const jsonFile = path.join(dir, `sub-work-order${trade ? `-${trade.toLowerCase().replace(/[^a-z0-9]+/g, "-")}` : ""}.json`);
  writeFileSync(jsonFile, JSON.stringify(order, null, 2));
  const printed = await runPython(hub, path.join(hub.cfg.hubRoot, "scripts", "sub_report.py"), [jsonFile, "--photos", photosDir, "--assets", path.join(hub.cfg.skillDir, "assets"), "--out", dir], dir);
  const file = printed.match(/^-> (.+)$/m)?.[1]?.trim();
  if (!file || !existsSync(file)) throw new Error(`The work order's PDF couldn't be made: ${printed.slice(0, 400)}`);
  const photos = order.rooms.reduce((t, r) => t + r.photos.length, 0);
  hub.jobs.log(n, `Sub work order made${trade ? ` for ${trade}` : ""}: ${path.basename(file)}`);
  hub.say(`Sub work order ready: ${path.basename(file)} (${order.rooms.length} room${order.rooms.length === 1 ? "" : "s"}, ${photos} photo${photos === 1 ? "" : "s"}${order.questions.length ? `, ${order.questions.length} thing${order.questions.length === 1 ? "" : "s"} to settle first` : ""}).`);
  return { file, questions: order.questions, rooms: order.rooms.length, photos, model: [...used][0] };
}
