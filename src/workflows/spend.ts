import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { ClaudeCost } from "../connectors/anthropicCost/index.js";

/**
 * What the paid AIs have cost this month, and how much of Hunter's budget is left.
 *
 * Neither Anthropic nor Google has an API that says how much prepaid credit is left, so Keystone keeps its own
 * tally: every Claude run reports its cost, and every Gemini answer reports its tokens (priced at the rates below,
 * which Hunter can change). He sets a monthly budget for each; "left" is budget minus spent. When an Anthropic
 * Admin key is set, Anthropic's own month-to-date figure (a few hours behind, but it counts everything on the
 * account, not only Keystone) is shown as well, and the larger of the two is used.
 */
export type Provider = "claude" | "google";
export interface Rate { in: number; out: number }
interface Month { claude: number; gemini: number; geminiTokens: Record<string, { in: number; out: number }> }
export interface Ledger {
  months: Record<string, Month>;
  budgets: Partial<Record<Provider, number>>;
  /** Dollars per million tokens, by model name; models not listed use DEFAULT_RATES. */
  geminiRates: Record<string, Rate>;
}

/** Google's list prices per million tokens at the time of writing; Hunter can set his own in the budget panel. */
export const DEFAULT_RATES: { match: RegExp; label: string; rate: Rate }[] = [
  { match: /lite/i, label: "Flash-Lite", rate: { in: 0.1, out: 0.4 } },
  { match: /pro|argon/i, label: "Pro", rate: { in: 1.25, out: 10 } },
  { match: /./, label: "Flash", rate: { in: 0.3, out: 2.5 } },
];

const file = (stateDir: string) => path.join(stateDir, "spend.json");
export const monthKey = (d = new Date()) => d.toLocaleDateString("en-CA", { timeZone: "America/Denver" }).slice(0, 7);

export function loadLedger(stateDir: string): Ledger {
  try {
    if (existsSync(file(stateDir))) return { months: {}, budgets: {}, geminiRates: {}, ...JSON.parse(readFileSync(file(stateDir), "utf8")) };
  } catch { /* start fresh */ }
  return { months: {}, budgets: {}, geminiRates: {} };
}
function saveLedger(stateDir: string, l: Ledger) {
  try { mkdirSync(stateDir, { recursive: true }); writeFileSync(file(stateDir), JSON.stringify(l, null, 1)); } catch { /* a tally is never worth failing a run over */ }
}
const month = (l: Ledger, k = monthKey()) => (l.months[k] ??= { claude: 0, gemini: 0, geminiTokens: {} });

export function rateFor(l: Ledger, model: string): Rate {
  return l.geminiRates[model] ?? DEFAULT_RATES.find((r) => r.match.test(model))!.rate;
}

/** A Claude run finished: what the API says it cost, in dollars. */
export function recordClaude(stateDir: string, usd: unknown) {
  const n = Number(usd);
  if (!Number.isFinite(n) || n <= 0) return;
  const l = loadLedger(stateDir);
  const m = month(l);
  m.claude = Math.round((m.claude + n) * 1e6) / 1e6;
  saveLedger(stateDir, l);
}

/** A Gemini answer: its tokens (input, and output including thinking). */
export function recordGemini(stateDir: string, model: string, input: number, output: number) {
  if (!(input > 0 || output > 0)) return;
  const l = loadLedger(stateDir);
  const m = month(l);
  const t = (m.geminiTokens[model] ??= { in: 0, out: 0 });
  t.in += input || 0;
  t.out += output || 0;
  const r = rateFor(l, model);
  m.gemini = Math.round((m.gemini + ((input || 0) * r.in + (output || 0) * r.out) / 1e6) * 1e6) / 1e6;
  saveLedger(stateDir, l);
}

export function setBudget(stateDir: string, p: Provider, dollars: number | null) {
  const l = loadLedger(stateDir);
  if (dollars == null || !Number.isFinite(dollars) || dollars <= 0) delete l.budgets[p];
  else l.budgets[p] = Math.round(dollars * 100) / 100;
  saveLedger(stateDir, l);
}

export function setGeminiRate(stateDir: string, model: string, rate: Rate | null) {
  const l = loadLedger(stateDir);
  if (!rate) delete l.geminiRates[model];
  else l.geminiRates[model] = rate;
  // Re-price this month's Gemini tokens at the new rates.
  const m = month(l);
  m.gemini = Object.entries(m.geminiTokens).reduce((s, [mod, t]) => { const r = rateFor(l, mod); return s + (t.in * r.in + t.out * r.out) / 1e6; }, 0);
  saveLedger(stateDir, l);
}

export interface BudgetLine {
  provider: Provider;
  label: string;
  /** This month's spend as Keystone counted it. */
  keystone: number;
  /** The provider's own month-to-date figure, when Keystone can read it. */
  official?: number;
  officialAsOf?: string;
  officialNote?: string;
  /** What's used against the budget: the larger of the two. */
  spent: number;
  budget: number | null;
  left: number | null;
  /** 0..1+, when there's a budget. */
  used: number | null;
  level: "ok" | "low" | "over" | "unset";
}
export interface BudgetReport {
  month: string;
  lines: BudgetLine[];
  geminiModels: { model: string; in: number; out: number; rate: Rate; custom: boolean }[];
  lastMonth: { claude: number; google: number } | null;
}

const line = (provider: Provider, label: string, keystone: number, budget: number | undefined, official?: { usd: number; asOf?: string } | { error: string } | null): BudgetLine => {
  const off = official && "usd" in official ? official : undefined;
  const spent = Math.max(keystone, off?.usd ?? 0);
  const b = budget ?? null;
  const used = b ? spent / b : null;
  return {
    provider, label, keystone: round(keystone), spent: round(spent), budget: b,
    left: b == null ? null : round(b - spent), used,
    level: b == null ? "unset" : used! >= 1 ? "over" : used! >= 0.8 ? "low" : "ok",
    ...(off ? { official: round(off.usd), officialAsOf: off.asOf } : {}),
    ...(official && "error" in official ? { officialNote: official.error } : {}),
  };
};
const round = (n: number) => Math.round(n * 100) / 100;

export async function budgetReport(stateDir: string, claudeCost?: ClaudeCost | null): Promise<BudgetReport> {
  const l = loadLedger(stateDir);
  const k = monthKey();
  const m = l.months[k] ?? { claude: 0, gemini: 0, geminiTokens: {} };
  let official: { usd: number; asOf?: string } | { error: string } | null = null;
  if (claudeCost) official = await claudeCost.monthToDate().catch((e) => ({ error: (e as Error).message.slice(0, 160) }));
  const prev = Object.keys(l.months).filter((x) => x < k).sort().at(-1);
  return {
    month: k,
    lines: [line("claude", "Claude (Anthropic)", m.claude, l.budgets.claude, official), line("google", "Gemini (Google)", m.gemini, l.budgets.google)],
    geminiModels: Object.entries(m.geminiTokens).map(([model, t]) => ({ model, in: t.in, out: t.out, rate: rateFor(l, model), custom: !!l.geminiRates[model] })),
    lastMonth: prev ? { claude: round(l.months[prev].claude), google: round(l.months[prev].gemini) } : null,
  };
}

/** True when this month's Claude spend has reached the budget Hunter set. */
export function claudeOverBudget(stateDir: string): { over: boolean; spent: number; budget?: number } {
  const l = loadLedger(stateDir);
  const spent = l.months[monthKey()]?.claude ?? 0;
  return { over: !!l.budgets.claude && spent >= l.budgets.claude, spent: round(spent), budget: l.budgets.claude };
}
