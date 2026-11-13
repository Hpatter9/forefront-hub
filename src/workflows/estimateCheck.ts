import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { complete } from "../agent/llm.js";
import type { Hub } from "../hub.js";
import { jobConversation } from "./conversation.js";
import { savedNotes } from "./pull.js";
import { withoutPrices } from "./subReport.js";

/**
 * A free second look at an estimate after it's written, so mistakes are caught without paying Claude to re-read
 * its own work. Two parts:
 *  1. Facts, checked by plain code against the skill's own files: every line's unit price against the job's price
 *     list and Forefront's price book, quantities against the room's measurements in the estimate, and slips
 *     (zero quantities, missing units, the same line twice).
 *  2. A read-through by the everyday AI (Gemini): the estimate's scope (prices removed) against what was actually
 *     said in the walk transcripts, notes, emails and texts: work that was asked for and isn't there, work nobody
 *     mentioned, measurements that disagree.
 * It only reports. Nothing in the estimate is changed, and no pricing or scoping rule lives here: prices are looked
 * up, not decided.
 */
export interface Finding {
  level: "wrong" | "look";
  where: string;
  what: string;
}
export interface EstimateCheck {
  at: string;
  lines: number;
  /** Lines whose price matched the price list or price book exactly. */
  pricesOk: number;
  findings: Finding[];
  /** The read-through against the walk, notes, emails and texts ("" when it couldn't be done, with why in `reviewNote`). */
  review: Finding[];
  reviewNote: string;
}

// ------------------------------------------------------------------ the skill's price files, read once
function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [], cell = "", quoted = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quoted) {
      if (c === '"' && text[i + 1] === '"') { cell += '"'; i++; }
      else if (c === '"') quoted = false;
      else cell += c;
    } else if (c === '"') quoted = true;
    else if (c === ",") { row.push(cell); cell = ""; }
    else if (c === "\n") { row.push(cell); rows.push(row); row = []; cell = ""; }
    else if (c !== "\r") cell += c;
  }
  if (cell || row.length) { row.push(cell); rows.push(row); }
  return rows;
}
const key = (desc: string, unit: string) => `${desc.trim().toLowerCase().replace(/\s+/g, " ")}|${unit.trim().toUpperCase()}`;
// (The same wording can be in the files more than once, at different prices: any of them is a match.)
let prices: { dir: string; stamp: number; list: Map<string, Map<string, number[]>>; book: Map<string, number[]> } | null = null;
const push = (m: Map<string, number[]>, k: string, v: number) => void (m.get(k) ?? m.set(k, []).get(k)!).push(v);
function priceFiles(skillDir: string) {
  const a = path.join(skillDir, "references", "xactimate_prices.csv"), b = path.join(skillDir, "references", "price_book.csv");
  const stamp = (existsSync(a) ? statSync(a).mtimeMs : 0) + (existsSync(b) ? statSync(b).mtimeMs : 0);
  if (prices?.dir === skillDir && prices.stamp === stamp) return prices;
  const list = new Map<string, Map<string, number[]>>(), book = new Map<string, number[]>();
  if (existsSync(a)) {
    const [head, ...rows] = parseCsv(readFileSync(a, "utf8"));
    const c = (n: string) => head.indexOf(n);
    for (const r of rows) {
      const pl = r[c("price_list")] ?? "", price = Number(r[c("price")]);
      if (!r[c("description")] || !Number.isFinite(price)) continue;
      push(list.get(pl) ?? list.set(pl, new Map()).get(pl)!, key(r[c("description")], r[c("unit")] ?? ""), price);
    }
  }
  if (existsSync(b)) {
    const [head, ...rows] = parseCsv(readFileSync(b, "utf8"));
    const c = (n: string) => head.indexOf(n);
    for (const r of rows) if (r[c("description")] && Number.isFinite(Number(r[c("median_price")]))) push(book, key(r[c("description")], r[c("unit")] ?? ""), Number(r[c("median_price")]));
  }
  prices = { dir: skillDir, stamp, list, book };
  return prices;
}

const money = (n: number) => `$${n.toFixed(2)}`;
const near = (a: number, b: number[]) => b.some((x) => Math.abs(a - x) < 0.011);
const says = (b: number[]) => [...new Set(b)].map(money).join(" or ");

interface Item { description?: string; quantity?: number; unit?: string; unit_price?: number; price_source?: string; trade?: string }
interface Estimate { price_list?: string; rooms?: { name?: string; floor_sf?: number; wall_sf?: number; ceiling_sf?: number; floor_perimeter_lf?: number }[]; sections?: { name?: string; option?: string; items?: Item[] }[] }

/** The facts: prices against the skill's price files, quantities against the room's own measurements, plain slips. */
export function checkFacts(hub: Hub, est: Estimate): Pick<EstimateCheck, "lines" | "pricesOk" | "findings"> {
  const p = priceFiles(hub.cfg.skillDir);
  const list = p.list.get(est.price_list ?? "") ?? new Map<string, number[]>();
  const findings: Finding[] = [];
  let lines = 0, pricesOk = 0;
  const rooms = new Map((est.rooms ?? []).map((r) => [String(r.name ?? "").trim().toLowerCase(), r]));
  if (est.price_list && !p.list.has(est.price_list)) findings.push({ level: "look", where: "Price list", what: `The estimate uses price list ${est.price_list}, which isn't in the skill's price file, so list prices couldn't be checked.` });
  for (const s of est.sections ?? []) {
    const where = String(s.name ?? "Section");
    const room = rooms.get(where.trim().toLowerCase());
    const seen = new Map<string, number>();
    for (const it of s.items ?? []) {
      lines++;
      const d = String(it.description ?? "").trim(), u = String(it.unit ?? "").trim(), q = Number(it.quantity), price = Number(it.unit_price);
      const tag = `${where}: ${d || "(no description)"}`;
      if (!d) findings.push({ level: "wrong", where, what: "A line has no description." });
      if (!u) findings.push({ level: "wrong", where, what: `${tag} has no unit.` });
      if (!(q > 0)) findings.push({ level: "wrong", where, what: `${tag} has a quantity of ${Number.isFinite(q) ? q : "nothing"}.` });
      if (!(price > 0)) findings.push({ level: "wrong", where, what: `${tag} has no unit price.` });
      const k = key(d, u);
      seen.set(k, (seen.get(k) ?? 0) + 1);
      // Price: the job's list when the item is on it, else the price book's median; "estimated" is Hunter's to confirm.
      const onList = list.get(k), inBook = p.book.get(k);
      if (it.price_source === "estimated") findings.push({ level: "look", where, what: `${tag} is priced by estimate (${money(price)}), not from the price list or price book. Confirm the number.` });
      else if (onList !== undefined) {
        if (near(price, onList)) pricesOk++;
        else if (it.price_source === "price_book" && inBook !== undefined && near(price, inBook)) findings.push({ level: "look", where, what: `${tag} uses the price book's ${money(price)}, but it's on the ${est.price_list} list at ${says(onList)}.` });
        else findings.push({ level: "wrong", where, what: `${tag} is priced ${money(price)}; the ${est.price_list} list says ${says(onList)} per ${u}.` });
      } else if (inBook !== undefined) {
        if (near(price, inBook)) pricesOk++;
        else findings.push({ level: "wrong", where, what: `${tag} is priced ${money(price)}; the price book's usual price is ${says(inBook)} per ${u}.` });
      } else if (d && price > 0) findings.push({ level: "look", where, what: `${tag} isn't in the price list or the price book (wording or unit differs?), so its ${money(price)} couldn't be checked.` });
      // Quantity against the room it's in, when the section is a measured room.
      if (room && q > 0) {
        const lower = d.toLowerCase(), U = u.toUpperCase();
        const floor = Number(room.floor_sf) || 0, walls = Number(room.wall_sf) || 0, ceil = Number(room.ceiling_sf) || 0, perim = Number(room.floor_perimeter_lf) || 0;
        const over = (limit: number, what: string) => { if (limit > 0 && q > limit * 1.15 + 1) findings.push({ level: "look", where, what: `${tag}: ${q} ${u} is more than the room's ${what} (${Math.round(limit * 10) / 10} ${u}).` }); };
        if (U === "SF" && /floor|vinyl|carpet|pad\b|underlayment|laminate|hardwood|tile floor|lvp|lvt/.test(lower) && !/wall|ceiling/.test(lower)) over(floor, "floor");
        else if (U === "SF" && /ceiling/.test(lower) && !/wall/.test(lower)) over(ceil, "ceiling");
        else if (U === "SF" && /wall|drywall|paint|seal|prime|texture|insulation/.test(lower)) over(walls + ceil, "walls and ceiling together");
        else if (U === "LF" && /baseboard|base shoe|quarter round|cove base/.test(lower)) over(perim, "perimeter");
      }
    }
    for (const [k, n] of seen) if (n > 1) findings.push({ level: "look", where, what: `"${k.split("|")[0]}" is on the list ${n} times in this section.` });
    if (!(s.items ?? []).length) findings.push({ level: "look", where, what: "This section has no line items." });
  }
  if (!lines) findings.push({ level: "wrong", where: "Estimate", what: "The estimate has no line items." });
  return { lines, pricesOk, findings };
}

const REVIEW_SCHEMA = {
  type: "object",
  properties: {
    findings: {
      type: "array",
      items: {
        type: "object",
        properties: {
          level: { type: "string", enum: ["wrong", "look"], description: "wrong = the sources plainly say something different; look = worth Hunter's eye" },
          where: { type: "string", description: "the room or section" },
          what: { type: "string", description: "one sentence: what the estimate has, what the source says, and which source (walk, notes, email from whom, text)" },
        },
        required: ["level", "where", "what"],
      },
    },
  },
  required: ["findings"],
};

/** The read-through: the estimate's scope against what was said on the job. Free (Gemini); quiet when there's nothing to compare. */
export async function reviewAgainstSources(hub: Hub, n: number, est: Estimate): Promise<{ review: Finding[]; note: string }> {
  const read = (f: string, max: number) => { try { return existsSync(f) ? readFileSync(f, "utf8").slice(0, max) : ""; } catch { return ""; } };
  const walksDir = hub.jobs.path(n, "notes", "walks");
  const walks = existsSync(walksDir) ? readdirSync(walksDir).filter((f) => f.endsWith(".md")).sort().map((f) => read(path.join(walksDir, f), 50_000)) : [];
  const notes = read(hub.jobs.path(n, "notes", "notes.txt"), 12_000);
  const team = savedNotes(hub, n).flatMap((x) => [x, ...x.replies]).map((x) => `${x.author}: ${x.body}`).slice(0, 40).join("\n").slice(0, 10_000);
  const conv = await jobConversation(hub, n).then((c) => c.items).catch(() => []);
  const said = conv.filter((x) => (x.kind === "email" && !x.draft) || x.kind === "text").slice(-60).map((x) => `[${x.kind} ${x.at.slice(0, 10)} ${x.fromMe ? "Hunter " : ""}${x.who}] ${x.subject ? `${x.subject}: ` : ""}${x.body.slice(0, 900)}`).join("\n");
  if (!walks.length && !notes.trim() && !team.trim() && !said.trim()) return { review: [], note: "There's no walk transcript, notes, emails or texts on the job to compare the estimate with." };
  try {
    const out = await complete<{ findings: Finding[] }>(hub, {
      system: `You double-check reconstruction estimates for Forefront Building + Restoration. You are given an estimate's scope (rooms, line items and quantities; prices removed) and everything that was said about the job. Find real disagreements only:
- work the customer, adjuster or Hunter asked for or agreed to that is NOT in the estimate;
- work in the estimate that the sources rule out, or that is in a room nobody mentioned;
- a measurement, count or material in the estimate that conflicts with one stated in the sources (say both numbers);
- a room named in the sources as damaged that has no section.
Do not comment on prices, wording, order, or things the sources are silent about. Do not suggest extra work. If everything agrees, return an empty list. Each finding is one sentence and names its source.`,
      prompt: `THE ESTIMATE (prices removed):\n${JSON.stringify(withoutPrices(est)).slice(0, 120_000)}\n\nSCOPE WALK TRANSCRIPTS:\n${walks.join("\n---\n") || "(none)"}\n\nHUNTER'S NOTES:\n${notes || "(none)"}\n\nTEAM NOTES:\n${team || "(none)"}\n\nEMAILS AND TEXTS:\n${said || "(none)"}`,
      schema: REVIEW_SCHEMA,
    });
    return { review: (out?.findings ?? []).filter((f) => f?.what).slice(0, 25).map((f) => ({ level: f.level === "wrong" ? "wrong" : "look", where: String(f.where ?? ""), what: String(f.what) })), note: "" };
  } catch (e) {
    return { review: [], note: `The read-through against your notes couldn't be done right now (${(e as Error).message.slice(0, 120)}).` };
  }
}

export async function checkEstimate(hub: Hub, n: number, o: { review?: boolean } = {}): Promise<EstimateCheck | null> {
  const f = hub.jobs.path(n, "estimate", "estimate.json");
  if (!existsSync(f)) return null;
  let est: Estimate;
  try { est = JSON.parse(readFileSync(f, "utf8")); } catch (e) { return { at: new Date().toISOString(), lines: 0, pricesOk: 0, findings: [{ level: "wrong", where: "Estimate", what: `estimate.json can't be read: ${(e as Error).message}` }], review: [], reviewNote: "" }; }
  const facts = checkFacts(hub, est);
  const r = o.review === false ? { review: [], note: "" } : await reviewAgainstSources(hub, n, est);
  return { at: new Date().toISOString(), ...facts, review: r.review, reviewNote: r.note };
}

/** The check as a short message for the Estimator's chat. */
export function checkText(c: EstimateCheck): string {
  const all = [...c.findings, ...c.review];
  const wrong = all.filter((x) => x.level === "wrong"), look = all.filter((x) => x.level === "look");
  const line = (x: Finding) => `- ${x.where ? `**${x.where}:** ` : ""}${x.what.replace(new RegExp(`^${x.where.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}:\\s*`), "")}`;
  return [
    `**Keystone's check (free, no Claude used)**`,
    `${c.pricesOk} of ${c.lines} line${c.lines === 1 ? "" : "s"} match the price list or price book exactly.${!all.length ? " Nothing else stood out." : ""}`,
    wrong.length ? `\n**Looks wrong (${wrong.length})**\n${wrong.map(line).join("\n")}` : "",
    look.length ? `\n**Worth a look (${look.length})**\n${look.map(line).join("\n")}` : "",
    c.reviewNote ? `\n${c.reviewNote}` : "",
  ].filter(Boolean).join("\n");
}
