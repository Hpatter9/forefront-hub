import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { Hub } from "../hub.js";

/**
 * A job's selections: the finishes the owner has to pick (flooring, tile, vanity, doors...), each with the quantity
 * and the material budget from the estimate, and the picks that come in (by email or added by hand) compared
 * against that budget. Kept in the job folder as selections.json. The categories and budgets are worked out by
 * Claude with the forefront-estimate skill (agent/selections.ts); this file only stores and compares.
 */
export interface Pick {
  id: string;
  product: string;
  brand?: string;
  color?: string;
  sku?: string;
  url?: string;
  /** A photo: a file in the job folder ("selections/...") or a web address. */
  image?: string;
  /** Price per the category's unit (e.g. per SF), when it's known. */
  pricePerUnit?: number;
  /** The price as written ("$3.49/sq ft", "$389 each"). */
  priceText?: string;
  note?: string;
  source: "email" | "manual";
  from?: string;
  threadId?: string;
  at: string;
  chosen: boolean;
}

export interface Category {
  id: string;
  name: string;
  room?: string;
  trade?: string;
  quantity: number;
  unit: string;
  /** Material budget per unit (not the installed price) and in total. */
  budgetPerUnit: number;
  budgetTotal: number;
  /** How the budget was worked out ("component cost, LVP, Denver list"). */
  basis?: string;
  status: "needed" | "selected" | "approved" | "ordered";
  picks: Pick[];
}

export interface Selections {
  updatedAt: string;
  builtAt?: string;
  builtFrom?: string;
  categories: Category[];
}

const file = (hub: Hub, n: number) => hub.jobs.path(n, "selections.json");

export function loadSelections(hub: Hub, n: number): Selections {
  try {
    if (existsSync(file(hub, n))) return JSON.parse(readFileSync(file(hub, n), "utf8"));
  } catch {
    // start fresh
  }
  return { updatedAt: "", categories: [] };
}

export function saveSelections(hub: Hub, n: number, s: Selections) {
  s.updatedAt = new Date().toISOString();
  mkdirSync(path.dirname(file(hub, n)), { recursive: true });
  writeFileSync(file(hub, n), JSON.stringify(s, null, 2));
}

const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 40) || "item";
export const newId = (prefix: string) => `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;

/** Replaces the categories with a fresh plan, keeping the picks already made under the same (or a similar) name. */
export function setCategories(hub: Hub, n: number, plan: Omit<Category, "id" | "status" | "picks">[], builtFrom: string): Selections {
  const old = loadSelections(hub, n);
  const key = (c: { name: string; room?: string }) => `${slug(c.name)}|${slug(c.room ?? "")}`;
  const cats: Category[] = plan.map((c) => {
    const prev = old.categories.find((o) => key(o) === key(c)) ?? old.categories.find((o) => slug(o.name) === slug(c.name));
    return { ...c, budgetTotal: round(c.budgetTotal || c.budgetPerUnit * c.quantity), id: prev?.id ?? `${slug(c.name)}-${Math.random().toString(36).slice(2, 6)}`, status: prev?.status ?? "needed", picks: prev?.picks ?? [] };
  });
  // Categories that had picks but aren't in the new plan stay, so nothing a customer sent is lost.
  for (const o of old.categories) if (o.picks.length && !cats.some((c) => c.id === o.id)) cats.push(o);
  const s: Selections = { updatedAt: "", builtAt: new Date().toISOString(), builtFrom, categories: cats };
  saveSelections(hub, n, s);
  return s;
}

const round = (x: number) => Math.round(x * 100) / 100;

/** A pick against its category's budget: the total at this price, and how far over (+) or under (-) it is. */
export function compare(c: Category, p: Pick): { total?: number; diff?: number; pct?: number; verdict: "under" | "over" | "on" | "unknown" } {
  if (p.pricePerUnit === undefined || !(c.quantity > 0)) return { verdict: "unknown" };
  const total = round(p.pricePerUnit * c.quantity);
  const diff = round(total - c.budgetTotal);
  const pct = c.budgetTotal ? Math.round((diff / c.budgetTotal) * 100) : 0;
  return { total, diff, pct, verdict: Math.abs(pct) <= 3 ? "on" : diff > 0 ? "over" : "under" };
}

/** Adds a pick to a category (the first pick in a category becomes the chosen one). */
export function addPick(hub: Hub, n: number, categoryId: string, pick: Omit<Pick, "id" | "chosen" | "at"> & { at?: string; chosen?: boolean }): Pick {
  const s = loadSelections(hub, n);
  const c = s.categories.find((x) => x.id === categoryId);
  if (!c) throw new Error("That selection category isn't on this job.");
  const p: Pick = { ...pick, id: newId("pick"), at: pick.at ?? new Date().toISOString(), chosen: pick.chosen ?? !c.picks.some((x) => x.chosen) };
  if (p.chosen) for (const x of c.picks) x.chosen = false;
  c.picks.push(p);
  if (c.status === "needed") c.status = "selected";
  saveSelections(hub, n, s);
  return p;
}

/** Adds a category by hand (or when a customer picks something the estimate didn't list). */
export function addCategory(hub: Hub, n: number, c: Omit<Category, "id" | "status" | "picks">): Category {
  const s = loadSelections(hub, n);
  const cat: Category = { ...c, budgetTotal: round(c.budgetTotal || c.budgetPerUnit * c.quantity), id: `${slug(c.name)}-${Math.random().toString(36).slice(2, 6)}`, status: "needed", picks: [] };
  s.categories.push(cat);
  saveSelections(hub, n, s);
  return cat;
}

/** Edits from the Selections tab: choose a pick, remove one, change a status or a budget. */
export function updateSelection(hub: Hub, n: number, o: { categoryId: string; pickId?: string; choose?: boolean; remove?: boolean; status?: Category["status"]; budgetPerUnit?: number; quantity?: number; removeCategory?: boolean }) {
  const s = loadSelections(hub, n);
  const c = s.categories.find((x) => x.id === o.categoryId);
  if (!c) throw new Error("That selection category isn't on this job.");
  if (o.removeCategory) s.categories = s.categories.filter((x) => x !== c);
  if (o.pickId) {
    const p = c.picks.find((x) => x.id === o.pickId);
    if (!p) throw new Error("That pick isn't there any more.");
    if (o.remove) {
      c.picks = c.picks.filter((x) => x !== p);
      if (p.chosen && c.picks[0]) c.picks[0].chosen = true;
      if (!c.picks.length && c.status === "selected") c.status = "needed";
    }
    if (o.choose) for (const x of c.picks) x.chosen = x === p;
  }
  if (o.status) c.status = o.status;
  if (o.quantity !== undefined && o.quantity >= 0) c.quantity = o.quantity;
  if (o.budgetPerUnit !== undefined && o.budgetPerUnit >= 0) c.budgetPerUnit = o.budgetPerUnit;
  if (o.quantity !== undefined || o.budgetPerUnit !== undefined) c.budgetTotal = round(c.budgetPerUnit * c.quantity);
  saveSelections(hub, n, s);
  return s;
}

/** The budget picture for a job: what's allowed, what's picked so far, and the difference. */
export function summary(s: Selections) {
  let budget = 0, picked = 0, pickedBudget = 0, open = 0, over = 0;
  for (const c of s.categories) {
    budget += c.budgetTotal;
    const chosen = c.picks.find((p) => p.chosen);
    const cmp = chosen ? compare(c, chosen) : null;
    if (cmp?.total !== undefined) {
      picked += cmp.total;
      pickedBudget += c.budgetTotal;
      if (cmp.verdict === "over") over++;
    } else if (!chosen) open++;
  }
  return { budget: round(budget), picked: round(picked), pickedBudget: round(pickedBudget), diff: round(picked - pickedBudget), open, over, count: s.categories.length };
}

/**
 * What a product page says about itself: name, photo and price, from its Open Graph / product meta tags and
 * schema.org Product data (what Home Depot, Floor & Decor, Lowe's, Build.com, Wayfair and most shops publish).
 */
export interface ProductPage {
  title?: string;
  image?: string;
  price?: number;
  priceText?: string;
  brand?: string;
  sku?: string;
}

export function parseProductPage(html: string, url: string): ProductPage {
  const meta = (prop: string) => {
    const re = new RegExp(`<meta[^>]+(?:property|name|itemprop)=["']${prop.replace(/[:.]/g, (c) => `\\${c}`)}["'][^>]*>`, "i");
    const tag = html.match(re)?.[0];
    return tag?.match(/content=["']([^"']*)["']/i)?.[1]?.trim() || undefined;
  };
  const out: ProductPage = {};
  // schema.org Product in JSON-LD
  for (const m of html.matchAll(/<script[^>]+type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi)) {
    let data: any;
    try {
      data = JSON.parse(m[1].trim());
    } catch {
      continue;
    }
    const nodes: any[] = [];
    const walk = (x: any) => {
      if (!x || typeof x !== "object") return;
      if (Array.isArray(x)) return x.forEach(walk);
      nodes.push(x);
      if (x["@graph"]) walk(x["@graph"]);
    };
    walk(data);
    const prod = nodes.find((x) => [x["@type"]].flat().some((t: string) => /product/i.test(String(t))));
    if (!prod) continue;
    out.title ??= prod.name;
    const img = [prod.image].flat()[0];
    out.image ??= typeof img === "string" ? img : img?.url;
    out.brand ??= typeof prod.brand === "string" ? prod.brand : prod.brand?.name;
    out.sku ??= prod.sku ?? prod.mpn;
    const offer = [prod.offers].flat()[0];
    const price = offer?.price ?? offer?.lowPrice ?? offer?.priceSpecification?.price;
    if (price !== undefined && !Number.isNaN(Number(price))) out.price ??= Number(price);
  }
  out.title ??= meta("og:title") ?? html.match(/<title[^>]*>([^<]+)<\/title>/i)?.[1]?.trim();
  out.image ??= meta("og:image") ?? meta("twitter:image");
  const mp = meta("product:price:amount") ?? meta("og:price:amount") ?? meta("price");
  if (out.price === undefined && mp && !Number.isNaN(Number(mp))) out.price = Number(mp);
  out.brand ??= meta("product:brand") ?? meta("og:brand");
  if (out.image && !/^https?:/i.test(out.image)) {
    try {
      out.image = new URL(out.image, url).toString();
    } catch {
      delete out.image;
    }
  }
  if (out.title) out.title = decode(out.title);
  if (out.price !== undefined) out.priceText = `$${out.price.toFixed(2)}`;
  return out;
}

const decode = (s: string) => s.replace(/&amp;/g, "&").replace(/&quot;/g, '"').replace(/&#39;|&apos;/g, "'").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/\s+/g, " ").trim();

/** Fetches a product page and reads it (best effort: some shops block automated visits; then only the link is kept). */
export async function productFromUrl(url: string): Promise<ProductPage> {
  try {
    const r = await fetch(url, { headers: { "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124 Safari/537.36", Accept: "text/html" }, redirect: "follow", signal: AbortSignal.timeout(15000) });
    if (!r.ok) return {};
    return parseProductPage((await r.text()).slice(0, 2_000_000), r.url || url);
  } catch {
    return {};
  }
}
