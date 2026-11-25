import { mkdtempSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { LiveClaudeCost, monthStartUtc } from "../src/connectors/anthropicCost/index.js";
import { budgetReport, claudeOverBudget, recordClaude, recordGemini, setBudget, setGeminiRate } from "../src/workflows/spend.js";

const dir = () => mkdtempSync(path.join(os.tmpdir(), "ks-spend-"));

describe("the API budget", () => {
  it("adds up Claude runs and Gemini tokens for the month and shows what's left", async () => {
    const d = dir();
    recordClaude(d, 1.25); recordClaude(d, 0.75); recordClaude(d, undefined); recordClaude(d, -3);
    recordGemini(d, "gemini-3.5-flash", 1_000_000, 200_000); // $0.30 + $0.50 at the Flash default
    let r = await budgetReport(d);
    expect(r.lines[0]).toMatchObject({ provider: "claude", spent: 2, budget: null, level: "unset" });
    expect(r.lines).toHaveLength(1); // Gemini is free: only Claude is on the budget
    setBudget(d, "claude", 2.4);
    r = await budgetReport(d);
    expect(r.lines[0]).toMatchObject({ left: 0.4, level: "low" });
    expect(claudeOverBudget(d).over).toBe(false);
    recordClaude(d, 0.5);
    expect(claudeOverBudget(d)).toMatchObject({ over: true, spent: 2.5, budget: 2.4 });
    expect((await budgetReport(d)).lines[0].level).toBe("over");
  });

  it("clears a budget left blank", async () => {
    const d = dir();
    setBudget(d, "claude", 5); setBudget(d, "claude", null);
    expect((await budgetReport(d)).lines[0].budget).toBeNull();
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
});
