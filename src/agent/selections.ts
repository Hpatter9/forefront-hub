import { query } from "@anthropic-ai/claude-agent-sdk";
import { aiProvider, aiReady, claudeOnlyReady, complete } from "./llm.js";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { Message } from "../connectors/gmail/types.js";
import type { Hub } from "../hub.js";
import { matchJob } from "../workflows/inbox.js";
import { isAutomated } from "../workflows/reminders.js";
import { addCategory, addPick, compare, loadSelections, productFromUrl, setCategories, type Category } from "../workflows/selections.js";
import { agentOptions, systemPrompt } from "./run.js";

/**
 * The two AI jobs for selections (on Gemini, free; setting up falls back to Claude with the skill only when there's
 * no Gemini key):
 * 1. buildSelections: read the job's estimate with the forefront-estimate skill and list the finishes the owner has
 *    to pick, with quantities and the MATERIAL budget for each (the skill's component costs, not installed prices).
 * 2. selectionsFromInbox: when a customer emails a pick (a product link or a photo), file it under the right
 *    category with the link, a photo and the price, compared against the budget.
 */
const PLAN_SCHEMA = {
  type: "object",
  properties: {
    source: { type: "string", description: "which file(s) the plan came from" },
    categories: {
      type: "array",
      items: {
        type: "object",
        properties: {
          name: { type: "string", description: "the finish to pick, e.g. 'LVP flooring', 'Shower wall tile', 'Vanity', 'Interior doors'" },
          room: { type: "string" },
          trade: { type: "string" },
          quantity: { type: "number", description: "with waste, in the estimate's unit" },
          unit: { type: "string", description: "SF, LF, EA, SY..." },
          budgetPerUnit: { type: "number", description: "material cost per unit the estimate allows (not installed price)" },
          basis: { type: "string", description: "one line on where the budget came from" },
        },
        required: ["name", "quantity", "unit", "budgetPerUnit"],
        additionalProperties: false,
      },
    },
  },
  required: ["categories"],
  additionalProperties: false,
};

type PlanCategory = Omit<Category, "id" | "status" | "picks" | "budgetTotal">;

const SELECTION_RULES = `List every finish the owner has to choose that this estimate replaces or installs: flooring (LVP, laminate, carpet and pad, tile, hardwood), wall and shower tile, cabinets and vanities, countertops, interior doors, trim/baseboard profile if it isn't matched to existing, plumbing fixtures and faucets, light fixtures, hardware, appliances. One category per finish per room (combine rooms that get the same finish into one category and name the rooms). Skip things that are matched to existing (texture, paint matched to existing, drywall) and anything with no owner choice.
For each: the quantity with waste in the estimate's unit, and the MATERIAL budget per unit the estimate allows (never the installed line-item price).`;

/**
 * Selections on Gemini (free): it reads the estimate (estimate.json, or the estimate PDFs), lists the finishes,
 * and takes material budgets from the estimate's own allowances or from the skill's component costs
 * (price_lookup.py --components, run here and handed back to it).
 */
async function planWithGemini(hub: Hub, n: number, say: (m: string) => void): Promise<{ source: string; categories: PlanCategory[] }> {
  const job = hub.jobs.get(n);
  const json = hub.jobs.path(n, "estimate", "estimate.json");
  const pdfs = [...hub.jobs.files(n, "estimate", /\.pdf$/i).filter((f) => /Reconstruction Estimate|Xactimate/i.test(path.basename(f))), ...hub.jobs.files(n, "files", /\.pdf$/i).filter((f) => /xactimate|estimate/i.test(path.basename(f)))];
  const useJson = existsSync(json);
  if (!useJson && !pdfs.length) throw new Error("No estimate on this job yet (estimate/estimate.json or an estimate PDF). Write the estimate first, or add categories by hand.");
  const source = useJson ? "estimate/estimate.json" : path.basename(pdfs[0]);
  const estimateText = useJson ? readFileSync(json, "utf8").slice(0, 60000) : "";
  const images = useJson ? [] : [{ mimeType: "application/pdf", data: readFileSync(pdfs[0]).toString("base64") }];
  const system = "You set up the owner's selections list for Forefront Building + Restoration reconstruction jobs. Work only from the estimate given; never invent quantities.";
  say(`  selections #${n}: reading ${source}`);
  const first = await complete<{ categories: (PlanCategory & { lookupWords?: string })[] }>(hub, {
    system,
    prompt: `Job #${n}, ${job.address}, market ${job.market || "unknown"}.\n${SELECTION_RULES}\nWhen the estimate states a selection allowance for a finish, use it as budgetPerUnit and say so in basis. Otherwise set budgetPerUnit to 0 and give lookupWords: 1–3 plain words to search Forefront's material cost list (e.g. "laminate", "carpet pad", "vanity").\n${useJson ? `The estimate (estimate.json):\n${estimateText}` : "The estimate is the attached PDF."}`,
    images,
    schema: {
      type: "object",
      properties: { categories: { type: "array", items: { type: "object", properties: { ...PLAN_SCHEMA.properties.categories.items.properties, lookupWords: { type: "string" } }, required: ["name", "quantity", "unit", "budgetPerUnit"] } } },
      required: ["categories"],
    },
  });
  const cats = first?.categories ?? [];
  const need = cats.filter((c) => !(c.budgetPerUnit > 0) && c.lookupWords);
  if (!need.length) return { source, categories: cats.map(({ lookupWords: _w, ...c }) => c) };
  const lookups: Record<string, string> = {};
  for (const c of need) {
    const words = String(c.lookupWords).split(/\s+/).filter(Boolean).slice(0, 3);
    if (lookups[words.join(" ")] !== undefined) continue;
    say(`  selections #${n}: looking up ${words.join(" ")} costs`);
    const r = await hub.skill.run("price_lookup.py", ["--components", ...words, "--limit", "25"]);
    lookups[words.join(" ")] = (r.stdout || r.stderr).slice(0, 4000);
  }
  const second = await complete<{ categories: PlanCategory[] }>(hub, {
    system,
    prompt: `Here is a selections list for job #${n} (market ${job.market || "unknown"}: CODE8X = Denver, COBO8X = Boulder). Fill in budgetPerUnit for every category that has 0: the MATERIAL cost per unit from Forefront's component costs below (pick the closest standard/average-grade match, in the category's unit, from the job's market list when there is one). Never use an installed line-item price. Put the code or description you used in basis. If nothing below fits, leave 0 and set basis to "Not in Forefront's cost list: set the budget by hand". Keep everything else as it is and return the whole list.
List: ${JSON.stringify(cats)}
Component costs found:
${Object.entries(lookups).map(([w, out]) => `--- ${w} ---\n${out}`).join("\n")}`,
    schema: PLAN_SCHEMA,
  });
  return { source, categories: second?.categories?.length ? second.categories : cats.map(({ lookupWords: _w, ...c }) => c) };
}

export async function buildSelections(hub: Hub, n: number, say: (m: string) => void = hub.say): Promise<number> {
  if (aiProvider(hub) === "gemini") {
    const out = await planWithGemini(hub, n, say);
    if (!out.categories.length) throw new Error("Gemini didn't find any finishes to select in this job's estimate.");
    setCategories(hub, n, out.categories.map((c) => ({ ...c, budgetTotal: Math.round((c.budgetPerUnit || 0) * c.quantity * 100) / 100 })), out.source);
    hub.jobs.log(n, `Selections list set up from the estimate (${out.categories.length} categories)`);
    return out.categories.length;
  }
  if (!claudeOnlyReady(hub)) throw new Error("Setting up selections uses the Claude estimating skill, so it needs a Claude API key (ANTHROPIC_API_KEY in Keystone's .env). You can add categories by hand.");
  const folder = hub.jobs.folder(n);
  const prompt = `Set up the selections list for job #${n} (folder: ${folder}).

Load the forefront-estimate skill first. Then read the job's estimate: estimate/estimate.json if it exists, otherwise the estimate PDFs in estimate/ or an Xactimate PDF in files/.

List every finish the owner has to choose that this estimate replaces or installs: flooring (LVP, laminate, carpet and pad, tile, hardwood), wall and shower tile, cabinets and vanities, countertops, interior doors, trim/baseboard profile if it isn't matched to existing, plumbing fixtures and faucets, light fixtures, hardware, appliances. One category per finish per room (combine rooms that get the same finish into one category and name the rooms). Skip things that are matched to existing (texture, paint matched to existing, drywall) and anything with no owner choice.

For each: the quantity with waste in the estimate's unit, and the MATERIAL budget per unit the estimate allows: use the estimate's own selections/allowances when it has them; otherwise the skill's component costs (python "${path.join(hub.cfg.skillDir, "scripts", "price_lookup.py")}" --components <words> --list <market list>), never the installed line-item price. One-line basis for each budget.

Return only the structured result.`;
  let out: { source?: string; categories: Omit<Category, "id" | "status" | "picks" | "budgetTotal">[] } | null = null;
  for await (const m of query({
    prompt,
    options: agentOptions(hub, { outputFormat: { type: "json_schema", schema: PLAN_SCHEMA }, maxTurns: 40, systemPrompt: { type: "preset", preset: "claude_code", append: systemPrompt(hub, n) } }, n),
  })) {
    if (m.type === "assistant") for (const b of m.message.content) if (b.type === "tool_use" && b.name === "Bash") say(`  selections #${n}: running ${String((b.input as any).command ?? "").match(/[\w-]+\.py/)?.[0] ?? "a command"}`);
    if (m.type === "result") {
      if (m.subtype !== "success") throw new Error(`Claude stopped (${m.subtype}).`);
      out = (m as any).structured_output ?? JSON.parse(m.result.match(/\{[\s\S]*\}/)?.[0] ?? "null");
    }
  }
  if (!out?.categories?.length) throw new Error("Claude didn't find any finishes to select in this job's estimate.");
  setCategories(hub, n, out.categories.map((c) => ({ ...c, budgetTotal: Math.round(c.budgetPerUnit * c.quantity * 100) / 100 })), out.source ?? "estimate");
  hub.jobs.log(n, `Selections list set up from the estimate (${out.categories.length} categories)`);
  return out.categories.length;
}

// ---------------------------------------------------------------------------------------------------------------
// Picks from customer email

const PICK_SCHEMA = {
  type: "object",
  properties: {
    picks: {
      type: "array",
      items: {
        type: "object",
        properties: {
          categoryId: { type: "string", description: "id of the matching category from the list, or \"\" if none fits" },
          newCategory: { type: "string", description: "only when categoryId is \"\": a short name for what this is (e.g. 'Bathroom faucet')" },
          product: { type: "string" },
          brand: { type: "string" },
          color: { type: "string" },
          sku: { type: "string" },
          url: { type: "string", description: "the product link from the email, exactly" },
          attachment: { type: "string", description: "filename of the attached photo that shows it, if any" },
          pricePerUnit: { type: "number", description: "price per the category's unit, only if the email states a price (convert a box/carton price using its coverage)" },
          priceText: { type: "string", description: "the price as written" },
          note: { type: "string" },
        },
        required: ["categoryId", "product"],
        additionalProperties: false,
      },
    },
  },
  required: ["picks"],
  additionalProperties: false,
};

interface State {
  since?: string;
  done: Record<string, number>; // messageId -> picks added
}
const stateFile = (hub: Hub) => path.join(hub.cfg.stateDir, "selection-emails.json");
const loadState = (hub: Hub): State => (existsSync(stateFile(hub)) ? JSON.parse(readFileSync(stateFile(hub), "utf8")) : { done: {} });
function saveState(hub: Hub, s: State) {
  mkdirSync(hub.cfg.stateDir, { recursive: true });
  writeFileSync(stateFile(hub), JSON.stringify(s, null, 2));
}

const LINK = /https?:\/\/[^\s<>"')]+/i;
const PICKY = /\b(select|selection|pick|picked|chose|choose|chosen|like (this|these|the)|love|went with|go(ing)? with|decided|prefer|want|color|colour|style|finish|floor|tile|lvp|vinyl|carpet|cabinet|vanity|counter|faucet|fixture|door|hardware|backsplash|grout)\b/i;

/** Could this email be a customer sending a pick? (A cheap check before asking Claude.) */
export function looksLikePick(m: Message): boolean {
  const photos = m.attachments.some((a) => /^image\//i.test(a.mimeType) || /\.(jpe?g|png|heic|webp)$/i.test(a.filename));
  return (LINK.test(m.body) || photos) && PICKY.test(`${m.subject}\n${m.body}`);
}

/** Reads one email for picks and files them on the job. Returns how many were added. */
export async function picksFromMessage(hub: Hub, n: number, m: Message, threadId: string): Promise<number> {
  let sel = loadSelections(hub, n);
  const cats = sel.categories.map((c) => `- ${c.id}: ${c.name}${c.room ? ` (${c.room})` : ""}, ${c.quantity} ${c.unit}, budget $${c.budgetPerUnit.toFixed(2)}/${c.unit}`).join("\n") || "(none set up yet)";
  const prompt = `A customer on reconstruction job #${n} emailed about their material selections. Find each product they picked (or are asking about as a choice) and match it to one of the job's selection categories.

Categories (id: name, quantity, budget):
${cats}

Rules: one entry per product. Use the exact product link from the email when there is one. If they attached a photo of it, give the attachment's filename. Give pricePerUnit only when the email states a price, converted to the category's unit (e.g. a $54.99 carton covering 20 SF is 2.75/SF). If nothing in the email is a pick, return an empty list.

From: ${m.from}
Date: ${m.date}
Subject: ${m.subject}
Attachments: ${m.attachments.map((a) => a.filename).join(", ") || "(none)"}

${m.body.slice(0, 6000)}`;
  let picks: any[] = [];
  picks = (await complete<{ picks?: any[] }>(hub, { system: "You read customer emails about construction material selections and pull out the products they picked.", prompt, schema: PICK_SCHEMA }))?.picks ?? [];
  let added = 0;
  for (const p of picks) {
    if (!p.product?.trim()) continue;
    sel = loadSelections(hub, n);
    let cat = sel.categories.find((c) => c.id === p.categoryId);
    if (!cat) cat = addCategory(hub, n, { name: p.newCategory || p.product, quantity: 0, unit: "EA", budgetPerUnit: 0, budgetTotal: 0, basis: "Not in the estimate: added from the customer's email" });
    // A photo: the attachment they sent, else the product page's own photo.
    let image: string | undefined;
    const att = p.attachment ? m.attachments.find((a) => a.filename === p.attachment) : m.attachments.find((a) => /^image\//i.test(a.mimeType));
    if (att && hub.gmail.attachment) {
      const rel = path.join("selections", `${m.date.slice(0, 10)} ${att.filename.replace(/[<>:"/\\|?*]/g, "_")}`);
      const f = hub.jobs.path(n, rel);
      mkdirSync(path.dirname(f), { recursive: true });
      if (!existsSync(f)) writeFileSync(f, await hub.gmail.attachment(m.id, att.id));
      image = rel.split(path.sep).join("/");
    }
    const page = p.url ? await productFromUrl(p.url) : {};
    image ??= page.image;
    const pricePerUnit = p.pricePerUnit ?? (page.price !== undefined && /^(EA|EACH)$/i.test(cat.unit) ? page.price : undefined);
    const pick = addPick(hub, n, cat.id, {
      product: p.product || page.title || "Product",
      brand: p.brand || page.brand,
      color: p.color,
      sku: p.sku || page.sku,
      url: p.url,
      image,
      pricePerUnit,
      priceText: p.priceText || page.priceText,
      note: p.note,
      source: "email",
      from: m.from,
      threadId,
      at: m.date,
    });
    const cmp = compare(cat, pick);
    hub.jobs.log(n, `Selection from ${m.from.replace(/<.*>/, "").trim()}: ${cat.name} → ${pick.product}${cmp.diff !== undefined ? ` (${cmp.diff >= 0 ? "$" + cmp.diff.toFixed(0) + " over" : "$" + (-cmp.diff).toFixed(0) + " under"} budget)` : ""}`);
    added++;
  }
  return added;
}

/** Looks at the last few days of incoming email for selections and files them. Runs with the inbox check. */
export async function selectionsFromInbox(hub: Hub): Promise<{ jobNumber: number; added: number; subject: string }[]> {
  if (!aiReady(hub) || hub.gmail.kind !== "google" || !hub.gmail.listThreads || (process.env.HUB_SELECTIONS_FROM_EMAIL ?? "on") === "off") return [];
  const s = loadState(hub);
  s.since ??= new Date().toISOString();
  saveState(hub, s);
  const me = hub.cfg.gmail.address.toLowerCase();
  const out: { jobNumber: number; added: number; subject: string }[] = [];
  const { threads } = await hub.gmail.listThreads({ q: "newer_than:3d -from:me -in:sent -in:chats -category:promotions", max: 30 });
  for (const th of threads) {
    const t = await hub.gmail.getThread(th.id, th.historyId).catch(() => null);
    for (const m of t?.messages ?? []) {
      if (s.done[m.id] !== undefined || new Date(m.date) < new Date(s.since)) continue;
      if (m.from.toLowerCase().includes(me) || isAutomated(m.from, "", m.subject) || !looksLikePick(m)) {
        s.done[m.id] = 0;
        continue;
      }
      const match = await matchJob(hub, m).catch(() => ({ jobNumber: undefined }));
      if (!match.jobNumber || !hub.jobs.exists(match.jobNumber)) {
        s.done[m.id] = 0;
        continue;
      }
      const added = await picksFromMessage(hub, match.jobNumber, m, th.id).catch((e) => {
        hub.say(`Couldn't read selections from "${m.subject}": ${(e as Error).message}`);
        return -1;
      });
      if (added < 0) continue; // try again next run
      s.done[m.id] = added;
      saveState(hub, s);
      if (added) out.push({ jobNumber: match.jobNumber, added, subject: m.subject });
    }
  }
  saveState(hub, s);
  return out;
}
