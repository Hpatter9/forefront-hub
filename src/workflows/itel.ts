import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { runPython } from "../agent/geminiEstimator.js";
import { aiProvider, complete } from "../agent/llm.js";
import type { Message } from "../connectors/gmail/types.js";
import type { Hub } from "../hub.js";
import { allSigns, belongsToJob, jobMailQuery } from "./jobMail.js";

/**
 * ITEL reports for a job. ITEL (Itel Laboratories) tests a sample of a damaged material, usually flooring, for the
 * carrier and reports the like-kind-and-quality replacement and its price. They arrive by email, often forwarded by
 * the adjuster. Before an estimate, Keystone looks through the job's email for them, saves each report into the
 * job's files/ITEL/ folder (plus any already sitting in the job folder), and writes a short summary next to each:
 * which material and rooms it covers, the matched product, the price and unit, and whether that includes
 * installation. How a report is used in the estimate is the estimating skill's rule ("ITEL pricing"); this only
 * brings the reports in and says what each one is for. The summary is made by the free AI (Gemini).
 */
export interface ItelSummary {
  material: string;
  rooms: string[];
  sample: string;
  matched: string;
  unitPrice: number | null;
  unit: string;
  includesInstall: "yes" | "no" | "unknown";
  reportNumber: string;
  date: string;
  notes: string;
}
export interface ItelReport {
  /** Relative to the job folder. */
  file: string;
  from?: string;
  receivedAt?: string;
  summary: ItelSummary | null;
  /** When there's no summary: why, and the start of the report's text. */
  problem?: string;
  excerpt?: string;
}

const ITEL_RX = /\bitel\b|itel lab|itelinc|itel\.com/i;
const isPdf = (name: string) => /\.pdf$/i.test(name);
const safe = (s: string) => s.replace(/[<>:"/\\|?*\x00-\x1f]/g, "_").trim();

function dirOf(hub: Hub, n: number) {
  return hub.jobs.path(n, "files", "ITEL");
}
const indexFile = (hub: Hub, n: number) => path.join(dirOf(hub, n), "index.json");
function loadIndex(hub: Hub, n: number): { saved: Record<string, string>; from: Record<string, { from: string; at: string }> } {
  try { return { saved: {}, from: {}, ...JSON.parse(readFileSync(indexFile(hub, n), "utf8")) }; } catch { return { saved: {}, from: {} }; }
}

/** An email that is an ITEL report for this job: ITEL named in it, a PDF attached, and the job's own signs. */
function isItelMail(m: Message): boolean {
  return m.attachments.some((a) => isPdf(a.filename)) && (ITEL_RX.test(m.from) || ITEL_RX.test(m.subject) || m.attachments.some((a) => ITEL_RX.test(a.filename)) || ITEL_RX.test(m.body.slice(0, 4000)));
}

/** Looks through the job's email for ITEL reports and saves any new ones. Returns the files it saved. */
export async function fetchItelReports(hub: Hub, n: number): Promise<string[]> {
  if (!hub.gmail.attachment) return [];
  const all = allSigns(hub);
  const q = jobMailQuery(all, n);
  let threads: { id: string }[] = [];
  if (hub.gmail.kind === "google") {
    if (!q) return [];
    threads = await hub.gmail.search(`(${q}) (itel OR "itel laboratories" OR filename:itel) has:attachment newer_than:730d`, 15).catch(() => []);
  } else threads = (await hub.gmail.listThreads?.({}).catch(() => ({ threads: [] })))?.threads ?? [];
  const idx = loadIndex(hub, n);
  const saved: string[] = [];
  for (const t of threads) {
    const th = await hub.gmail.getThread(t.id).catch(() => null);
    for (const m of th?.messages ?? []) {
      if (!isItelMail(m)) continue;
      // The job's claim, address or people have to be in it, so another job's report isn't brought in.
      if (!belongsToJob(all, n, `${m.subject}\n${m.body.slice(0, 20000)}\n${m.attachments.map((a) => a.filename).join(" ")}`, [m.from, ...m.to, ...m.cc]).belongs) continue;
      for (const a of m.attachments.filter((x) => isPdf(x.filename))) {
        const key = `${m.id}:${a.id}`;
        if (idx.saved[key] && existsSync(path.join(hub.jobs.folder(n), idx.saved[key]))) continue;
        const dir = dirOf(hub, n);
        mkdirSync(dir, { recursive: true });
        let name = safe(`${m.date.slice(0, 10)} ${a.filename}`);
        for (let i = 2; existsSync(path.join(dir, name)); i++) name = safe(`${m.date.slice(0, 10)} ${path.basename(a.filename, ".pdf")} (${i}).pdf`);
        writeFileSync(path.join(dir, name), await hub.gmail.attachment(m.id, a.id));
        const rel = `files/ITEL/${name}`;
        idx.saved[key] = rel;
        idx.from[rel] = { from: m.from, at: m.date };
        saved.push(rel);
      }
    }
  }
  // Reports already in the job folder (dropped in by hand, or filed with an email) are brought together too.
  for (const sub of ["files", "email"] as const) {
    const walk = (dir: string): string[] => (existsSync(dir) ? readdirSync(dir).flatMap((f) => { const full = path.join(dir, f); return statSync(full).isDirectory() ? (f === "ITEL" ? [] : walk(full)) : [full]; }) : []);
    for (const f of walk(hub.jobs.path(n, sub)).filter((x) => isPdf(x) && ITEL_RX.test(path.basename(x)))) {
      const target = path.join(dirOf(hub, n), safe(path.basename(f)));
      if (existsSync(target) || Object.values(idx.saved).includes(path.relative(hub.jobs.folder(n), f).split(path.sep).join("/"))) continue;
      mkdirSync(dirOf(hub, n), { recursive: true });
      copyFileSync(f, target);
      saved.push(`files/ITEL/${path.basename(target)}`);
    }
  }
  if (saved.length || Object.keys(idx.saved).length) {
    mkdirSync(dirOf(hub, n), { recursive: true });
    writeFileSync(indexFile(hub, n), JSON.stringify(idx, null, 1));
  }
  if (saved.length) {
    hub.jobs.log(n, `ITEL report${saved.length === 1 ? "" : "s"} brought in: ${saved.map((s) => path.basename(s)).join(", ")}`);
    hub.say(`#${n}: found ${saved.length} ITEL report${saved.length === 1 ? "" : "s"} and saved ${saved.length === 1 ? "it" : "them"} in files/ITEL.`);
  }
  return saved;
}

const SCHEMA = {
  type: "object",
  properties: {
    material: { type: "string", description: "the material the report covers, e.g. carpet, vinyl plank, laminate, hardwood, tile, countertop" },
    rooms: { type: "array", items: { type: "string" }, description: "the rooms or areas the sample is from or the report applies to, as written; empty if it doesn't say" },
    sample: { type: "string", description: "what the lab found the existing material to be" },
    matched: { type: "string", description: "the like-kind-and-quality replacement: manufacturer, product, style, color" },
    unitPrice: { type: ["number", "null"], description: "the replacement's unit price as reported, a number" },
    unit: { type: "string", description: "SF, SY, LF, EA or as written" },
    includesInstall: { type: "string", enum: ["yes", "no", "unknown"], description: "whether that price includes installation, only if the report says" },
    reportNumber: { type: "string" },
    date: { type: "string", description: "the report's date, YYYY-MM-DD if given" },
    notes: { type: "string", description: "anything else on pricing: tax, freight, pad included, more than one material" },
  },
  required: ["material", "rooms", "sample", "matched", "unitPrice", "unit", "includesInstall", "reportNumber", "date", "notes"],
};

/** The job's ITEL reports with their summaries (made once per report, by the free AI). */
export async function itelReports(hub: Hub, n: number, o: { cachedOnly?: boolean } = {}): Promise<ItelReport[]> {
  const dir = dirOf(hub, n);
  if (!existsSync(dir)) return [];
  const idx = loadIndex(hub, n);
  const out: ItelReport[] = [];
  for (const f of readdirSync(dir).filter(isPdf).sort()) {
    const rel = `files/ITEL/${f}`, sumFile = path.join(dir, `${f}.summary.json`);
    const base: ItelReport = { file: rel, from: idx.from[rel]?.from, receivedAt: idx.from[rel]?.at, summary: null };
    if (existsSync(sumFile)) {
      try { out.push({ ...base, ...JSON.parse(readFileSync(sumFile, "utf8")) }); continue; } catch { /* make it again */ }
    }
    const text = await runPython(hub, path.join(hub.cfg.hubRoot, "scripts", "pdf_text.py"), [path.join(dir, f), "--max-pages", "15"], hub.jobs.folder(n));
    const excerpt = text.slice(0, 1500);
    if (o.cachedOnly || aiProvider(hub) !== "gemini") { out.push({ ...base, problem: "Not summarised yet: read the PDF itself.", excerpt }); continue; }
    try {
      const s = await complete<ItelSummary>(hub, {
        system: "You read ITEL (Itel Laboratories) material analysis reports for a reconstruction estimator. Copy what the report says exactly; never estimate or fill in a price, product or room it doesn't give.",
        prompt: `The report's text:\n\n${text.slice(0, 60_000)}`,
        schema: SCHEMA,
        fast: true,
      });
      const r: ItelReport = { ...base, summary: s ?? null, ...(s ? {} : { problem: "The summary couldn't be made: read the PDF itself.", excerpt }) };
      if (s) writeFileSync(sumFile, JSON.stringify({ summary: s }, null, 1));
      out.push(r);
    } catch (e) {
      out.push({ ...base, problem: `The summary couldn't be made (${(e as Error).message.slice(0, 120)}): read the PDF itself.`, excerpt });
    }
  }
  return out;
}

/** One line per report, for a brief or a chat. */
export const itelLine = (r: ItelReport) => r.summary
  ? `${path.basename(r.file)}: ${r.summary.material}${r.summary.rooms.length ? ` in ${r.summary.rooms.join(", ")}` : ""}; matched ${r.summary.matched}${r.summary.unitPrice != null ? ` at $${r.summary.unitPrice}/${r.summary.unit}` : ""}${r.summary.includesInstall === "yes" ? " installed" : r.summary.includesInstall === "no" ? " (material only)" : " (doesn't say whether installed)"}${r.summary.reportNumber ? `, report ${r.summary.reportNumber}` : ""}`
  : `${path.basename(r.file)}: ${r.problem ?? "not summarised"}`;
