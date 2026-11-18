import { mkdtempSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { LiveClaudeCost, monthStartUtc } from "../src/connectors/anthropicCost/index.js";
import { LiveGemini, MeteredGemini } from "../src/connectors/gemini/index.js";
import { budgetReport, claudeOverBudget, recordClaude, recordGemini, setBudget, setGeminiRate } from "../src/workflows/spend.js";

const dir = () => mkdtempSync(path.join(os.tmpdir(), "ks-spend-"));

describe("the API budget", () => {
  it("adds up Claude runs and Gemini tokens for the month and shows what's left", async () => {
    const d = dir();
    recordClaude(d, 1.25); recordClaude(d, 0.75); recordClaude(d, undefined); recordClaude(d, -3);
    recordGemini(d, "gemini-3.5-flash", 1_000_000, 200_000); // $0.30 + $0.50 at the Flash default
    let r = await budgetReport(d);
    expect(r.lines[0]).toMatchObject({ provider: "claude", spent: 2, budget: null, level: "unset" });
    expect(r.lines[1]).toMatchObject({ provider: "google", spent: 0.8 });
    setBudget(d, "claude", 2.4); setBudget(d, "google", 10);
    r = await budgetReport(d);
    expect(r.lines[0]).toMatchObject({ left: 0.4, level: "low" });
    expect(r.lines[1]).toMatchObject({ left: 9.2, level: "ok" });
    expect(claudeOverBudget(d).over).toBe(false);
    recordClaude(d, 0.5);
    expect(claudeOverBudget(d)).toMatchObject({ over: true, spent: 2.5, budget: 2.4 });
    expect((await budgetReport(d)).lines[0].level).toBe("over");
  });

  it("re-prices Gemini when Hunter sets his own rate, and clears a budget left blank", async () => {
    const d = dir();
    recordGemini(d, "gemini-hydrogen", 2_000_000, 1_000_000);
    setGeminiRate(d, "gemini-hydrogen", { in: 1, out: 4 });
    const r = await budgetReport(d);
    expect(r.lines[1].spent).toBe(6);
    expect(r.geminiModels[0]).toMatchObject({ model: "gemini-hydrogen", custom: true, rate: { in: 1, out: 4 } });
    setBudget(d, "google", 5); setBudget(d, "google", null);
    expect((await budgetReport(d)).lines[1].budget).toBeNull();
  });

  it("uses Anthropic's own count when it's higher (it covers the whole account)", async () => {
    const d = dir();
    recordClaude(d, 3);
    setBudget(d, "claude", 20);
    const cost = { kind: "mock" as const, monthToDate: async () => ({ usd: 7.5, asOf: "2026-11-18T00:00:00Z" }) };
    expect((await budgetReport(d, cost)).lines[0]).toMatchObject({ keystone: 3, official: 7.5, spent: 7.5, left: 12.5 });
    const broken = { kind: "mock" as const, monthToDate: async () => { throw new Error("not an admin key"); } };
    expect((await budgetReport(d, broken)).lines[0]).toMatchObject({ spent: 3, officialNote: "not an admin key" });
  });

  it("reads Anthropic's month-to-date cost in cents from the cost analytics list", async () => {
    let asked: any = null;
    const rows = [{ cost: { amount: "1234.5", currency: "USD", list_amount: "0", requests: 3 }, ending_at: "2026-11-17T20:00:00Z", starting_at: "2026-11-01T00:00:00Z", group: {} }, { cost: { amount: "65.5", currency: "USD", list_amount: "0", requests: 1 }, ending_at: "2026-11-18T02:00:00Z", starting_at: "2026-11-01T00:00:00Z", group: {} }];
    const client = { beta: { organization: { analytics: { cost: { list: (p: any) => { asked = p; return (async function* () { yield* rows; })(); } } } } } } as any;
    const c = new LiveClaudeCost("sk-ant-admin-x", client);
    expect(await c.monthToDate()).toEqual({ usd: 13, asOf: "2026-11-18T02:00:00Z" });
    expect(asked).toEqual({ starting_at: monthStartUtc() });
    expect(monthStartUtc(new Date("2026-11-18T12:00:00Z"))).toBe("2026-11-01T00:00:00Z");
  });

  it("counts every Gemini answer's tokens, thinking included", async () => {
    const d = dir();
    const fake = (async () => new Response(JSON.stringify({ candidates: [{ content: { role: "model", parts: [{ text: "hi" }] } }], usageMetadata: { promptTokenCount: 1_000_000, candidatesTokenCount: 100_000, thoughtsTokenCount: 100_000 } }), { status: 200 })) as typeof fetch;
    const g = new MeteredGemini(new LiveGemini("k", fake), d);
    const r = await g.generate({ model: "gemini-flash-lite-latest", system: "s", contents: [{ role: "user", parts: [{ text: "hi" }] }] });
    expect(r.usage).toEqual({ input: 1_000_000, output: 200_000 });
    const rep = await budgetReport(d);
    expect(rep.lines[1].spent).toBe(0.18); // Flash-Lite: $0.10 in + 0.2M x $0.40 out
    expect(rep.geminiModels[0]).toMatchObject({ model: "gemini-flash-lite-latest", in: 1_000_000, out: 200_000 });
  });
});
