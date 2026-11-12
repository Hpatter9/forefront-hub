import { existsSync, mkdirSync, readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { readXlsx } from "../core/xlsx.js";
import type { Hub } from "../hub.js";

/**
 * The shop's overstock: flooring, tile, cove base, setting materials and so on left over from jobs, which Hunter
 * wants to use on new jobs when it fits. It's whatever Excel file is in Keystone's `inventory` folder (the newest
 * one; never committed, since its notes can name customers). Keystone reads it as-is: every sheet with a header
 * row is a list of items, except a sheet of things already thrown out. Replace the file and Keystone has the new
 * counts. It's offered three ways: the AI can look it up, a job's page lists stock of the kinds that job's scope
 * talks about, and the estimator is told to check it before pricing new material.
 */
export interface StockItem {
  sheet: string;
  item: string; // "LVP 1", "Cove Base 4"
  type: string; // LVP / LVT, Tile, Carpet, Cove Base, ...
  product: string;
  color: string;
  sku: string;
  /** How much, in words, from the counts that are filled in ("23 boxes, 429 sq ft"); "" when it hasn't been counted. */
  amount: string;
  sqft: number | null;
  linearFt: number | null;
  location: string;
  /** Keep for stock / sell / undecided, when the sheet says. */
  status: string;
  notes: string;
}

export const inventoryDir = (hub: Hub) => path.join(hub.cfg.hubRoot, "inventory");

export function inventoryFile(hub: Hub): string | null {
  const dir = inventoryDir(hub);
  // The folder is made for Hunter, so all he has to do is save the spreadsheet into it.
  try { mkdirSync(dir, { recursive: true }); } catch { return null; }
  const files = readdirSync(dir).filter((f) => /\.xlsx$/i.test(f) && !f.startsWith("~$")).map((f) => path.join(dir, f));
  return files.sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs)[0] ?? null;
}

const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) && v > 0 ? v : null);
const str = (v: unknown) => (v === null || v === undefined ? "" : typeof v === "number" ? String(Number.isInteger(v) ? v : Math.round(v * 100) / 100) : String(v).trim());
const round = (n: number) => (Math.round(n * 10) / 10).toLocaleString("en-US");

let cache: { file: string; mtime: number; items: StockItem[] } | null = null;

export function inventory(hub: Hub): { file: string | null; updatedAt?: string; items: StockItem[]; problem?: string } {
  const file = inventoryFile(hub);
  if (!file) return { file: null, items: [], problem: `No inventory file yet. Save the shop's inventory spreadsheet (.xlsx) into ${inventoryDir(hub)}.` };
  const mtime = statSync(file).mtimeMs;
  if (cache?.file === file && cache.mtime === mtime) return { file, updatedAt: new Date(mtime).toISOString(), items: cache.items };
  let items: StockItem[] = [];
  try {
    for (const sheet of readXlsx(file)) {
      if (/toss|discard|sold|gone/i.test(sheet.name)) continue; // not on the shelf any more
      const head = sheet.rows[0]?.map((h) => str(h).toLowerCase()) ?? [];
      const find = (...rx: RegExp[]) => rx.map((r) => head.findIndex((h) => r.test(h))).find((i) => i >= 0) ?? -1;
      const c = {
        type: find(/material type|^type$|category/), product: find(/brand|product|description|^item$/), color: find(/color|finish/), sku: find(/sku|product no|part/),
        boxes: find(/^boxes$|rolls|boxes|qty|quantity|count/), sqft: find(/total sq ?ft|^sq ?ft$|total square/), per: find(/per box|per roll/), lf: find(/total linear|linear f(ee)?t$/), height: find(/height/),
        where: find(/location/), status: find(/keep|sell|status/), notes: find(/notes?/),
      };
      if (c.product < 0) continue;
      const unit = /roll/.test(head[c.boxes] ?? "") ? "roll" : "box";
      for (const [i, r] of sheet.rows.slice(1).entries()) {
        const product = str(r[c.product]);
        if (!product) continue;
        const type = c.type >= 0 ? str(r[c.type]) : sheet.name;
        const boxes = num(r[c.boxes]), per = num(r[c.per]);
        const sqft = num(r[c.sqft]) ?? (boxes && per && c.sqft >= 0 ? boxes * per : null);
        const lf = c.lf >= 0 ? num(r[c.lf]) ?? (boxes && per ? boxes * per : null) : null;
        const amount = [boxes ? `${round(boxes)} ${unit}${boxes === 1 ? "" : unit === "box" ? "es" : "s"}` : "", sqft ? `${round(sqft)} sq ft` : "", lf ? `${round(lf)} linear ft` : ""].filter(Boolean).join(", ");
        items.push({
          sheet: sheet.name, item: `${type || sheet.name} ${str(r[0]) || i + 1}`, type: type || sheet.name,
          product: [product, c.height >= 0 ? str(r[c.height]) : ""].filter(Boolean).join(", "), color: c.color >= 0 ? str(r[c.color]) : "", sku: c.sku >= 0 ? str(r[c.sku]) : "",
          amount, sqft, linearFt: lf, location: c.where >= 0 ? str(r[c.where]) : "", status: c.status >= 0 && !/keep.*per|notes/.test(head[c.status]) ? str(r[c.status]) : "", notes: c.notes >= 0 ? str(r[c.notes]) : "",
        });
      }
    }
  } catch (e) {
    return { file, items: [], problem: `Couldn't read ${path.basename(file)}: ${(e as Error).message}` };
  }
  // Things that aren't ours to use aren't offered.
  items = items.filter((x) => !/\bnot ours\b|customer-owned/i.test(`${x.product} ${x.notes}`));
  cache = { file, mtime, items };
  return { file, updatedAt: new Date(mtime).toISOString(), items };
}

/** Words in a job's scope that point at a kind of stock. */
const KINDS: { kind: string; scope: RegExp; stock: RegExp }[] = [
  { kind: "vinyl plank / LVT", scope: /\b(lvp|lvt|vinyl plank|luxury vinyl|vinyl floor(ing)?|floating floor)\b/i, stock: /lvp|lvt|vinyl/i },
  { kind: "tile", scope: /\b(tile|porcelain|ceramic|backsplash|shower (surround|walls?|pan)|tub surround)\b/i, stock: /^tile$|\btile\b(?! level)/i },
  { kind: "carpet", scope: /\bcarpet(ing)?\b/i, stock: /carpet/i },
  { kind: "cove base", scope: /\b(cove base|rubber base|vinyl base|wall base)\b/i, stock: /cove base/i },
  { kind: "tile setting materials", scope: /\b(tile|thinset|grout|waterproof(ing)?|membrane|shower pan|curb)\b/i, stock: /grout|thinset|waterproof|leveling|curb/i },
  { kind: "flooring adhesive and patch", scope: /\b(glue[- ]down|adhesive|floor patch|floor prep|feather finish|skim coat)\b/i, stock: /adhesive|feather|patch/i },
  { kind: "paint", scope: /\b(paint|prime|primer|repaint)\b/i, stock: /paint/i },
  { kind: "transitions", scope: /\b(transition|t-?mold(ing)?|reducer|threshold)\b/i, stock: /trim|molding|transition/i },
];

/** Stock of the kinds a piece of scope text talks about (an estimate, walk notes, team notes), biggest first. */
export function stockFor(hub: Hub, scopeText: string): { kind: string; items: StockItem[] }[] {
  const { items } = inventory(hub);
  if (!items.length || !scopeText.trim()) return [];
  const out: { kind: string; items: StockItem[] }[] = [];
  for (const k of KINDS) {
    if (!k.scope.test(scopeText)) continue;
    const hits = items.filter((x) => k.stock.test(x.type) || k.stock.test(x.sheet) || (x.type.toLowerCase() === "other" && k.stock.test(x.product))).sort((a, b) => (b.sqft ?? b.linearFt ?? 0) - (a.sqft ?? a.linearFt ?? 0));
    if (hits.length) out.push({ kind: k.kind, items: hits });
  }
  return out;
}

/** What a job's scope is, in its own words: the estimate's lines, walk recordings, team notes and job notes. */
export function jobScopeText(hub: Hub, n: number): string {
  const parts: string[] = [];
  const read = (f: string) => { try { return existsSync(f) ? readFileSync(f, "utf8") : ""; } catch { return ""; } };
  parts.push(read(hub.jobs.path(n, "estimate", "estimate.json")).slice(0, 200_000));
  for (const dir of [hub.jobs.path(n, "notes"), hub.jobs.path(n, "notes", "walks")]) {
    if (!existsSync(dir)) continue;
    for (const f of readdirSync(dir)) if (/\.(md|txt)$/i.test(f) || f === "homebase-notes.json") parts.push(read(path.join(dir, f)).slice(0, 60_000));
  }
  return parts.join("\n");
}

/**
 * For a job's page: stock of the kinds its scope mentions, plus anything whose note names this job or customer
 * (set aside for them). Empty when there's no inventory file or nothing fits.
 */
export function stockForJob(hub: Hub, n: number): { kinds: { kind: string; items: StockItem[] }[]; named: StockItem[]; updatedAt?: string } {
  const inv = inventory(hub);
  if (!inv.items.length || !hub.jobs.exists(n)) return { kinds: [], named: [] };
  const j = hub.jobs.get(n);
  const names = [...new Set([j.name, (j.customer.attention || j.customer.name).split(/\s+/).at(-1) ?? ""].map((x) => x.trim().toLowerCase()).filter((x) => x.length >= 4))];
  const named = inv.items.filter((x) => names.some((nm) => new RegExp(`\\b${nm.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`, "i").test(x.notes)));
  return { kinds: stockFor(hub, jobScopeText(hub, n)), named, updatedAt: inv.updatedAt };
}

/** A line for the AI's instructions, when there is stock. */
export function inventoryNote(hub: Hub): string {
  const n = inventory(hub).items.length;
  return n ? `The shop has overstock Hunter wants used on jobs when it fits (${n} items: flooring, tile, carpet tile, cove base, setting materials, paint). Look it up with shop_stock. Whenever a job's scope includes flooring, tile, cove base, waterproofing, grout, adhesive or paint, check the stock and tell Hunter what could be used (product, color, how much is on hand against what the job needs, and where it is), including when an item's note names that customer. It's a reminder for him to decide: never put shop stock on an estimate or change a price on your own.` : "";
}

/** A lookup for the AI: everything, or what matches the words ("LVP", "daltile beige", "cove base black"). */
export function findStock(hub: Hub, query = ""): StockItem[] {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  return inventory(hub).items.filter((x) => words.every((w) => `${x.type} ${x.sheet} ${x.product} ${x.color} ${x.sku} ${x.notes} ${x.status}`.toLowerCase().includes(w)));
}

/** One line per item, for a prompt or a card. */
export const stockLine = (x: StockItem) => `${x.type}: ${x.product}${x.color && !/^n\/a$/i.test(x.color) ? `, ${x.color}` : ""}${x.amount ? ` (${x.amount})` : " (not counted yet)"}${x.status ? ` [${x.status}]` : ""}`;
