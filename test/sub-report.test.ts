import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { MockGemini } from "../src/connectors/gemini/index.js";
import { makeSubReport, withoutPrices } from "../src/workflows/subReport.js";
import { ESTIMATOR_DIR, testHub } from "./helpers.js";

function setup() {
  const t = testHub();
  t.hub.cfg.skillDir = path.join(ESTIMATOR_DIR, "skill", "forefront-estimate");
  t.hub.cfg.hubRoot = process.cwd(); // scripts/sub_report.py
  t.hub.cfg.ai = { provider: "gemini", geminiKey: "k", geminiModel: "main", geminiFastModel: "fast" };
  t.hub.jobs.upsert(6600, { name: "Okafor", address: "88 Birch Ln, Denver, CO" });
  const put = (rel: string, text: string) => { const f = path.join(t.hub.jobs.folder(6600), rel); mkdirSync(path.dirname(f), { recursive: true }); writeFileSync(f, text); };
  return { ...t, put };
}
const ESTIMATE = { customer: "Okafor", overhead_pct: 10, rooms: [{ name: "Hall Bath", items: [{ description: "Paint the walls - two coats", qty: 128, unit: "SF", unit_price: 1.82, total: 232.96 }, { description: "Baseboard", qty: 26, unit: "LF", unit_price: 4.28 }] }], grand_total: 1748.04 };

describe("the sub work order", () => {
  it("takes every price out of the estimate before anything is written from it", () => {
    const clean = JSON.stringify(withoutPrices(ESTIMATE));
    expect(clean).toContain("Paint the walls - two coats");
    expect(clean).toContain("128");
    for (const gone of ["1.82", "232.96", "4.28", "1748.04", "overhead_pct", "unit_price", "grand_total"]) expect(clean).not.toContain(gone);
  });

  it("has Gemini write it from the estimate and the walk, prints a PDF, and turns anything unsettled into a question", async () => {
    const { hub, put } = setup();
    put("estimate/estimate.json", JSON.stringify(ESTIMATE));
    put("notes/walks/2026-11-12 0900 walk.md", "Hunter: paint the tub wall. Baseboard all the way around.");
    hub.gemini = new MockGemini(() => JSON.stringify({
      summary: "Supply line leak in the hall bath.", access: "", general: ["Protect the hallway floor."],
      rooms: [{ room: "Hall Bath", work: [{ trade: "Paint", task: "Paint the tub wall, two coats", qty: "128 SF" }, { trade: "Trim", task: "Replace baseboard on all walls", qty: "26 LF" }], paint: { walls: "The tub wall only", ceiling: "NOT SETTLED", trim: "Baseboard, 26 LF", color: "NOT SETTLED", prep: "Mask the tub" }, notes: ["Vanity stays."], photos: [{ number: 4, caption: "not a real photo" }] }],
      questions: ["Hall Bath: what color and sheen for the walls?"],
    }));
    const r = await makeSubReport(hub, 6600, { trade: "Painter" });
    expect(path.basename(r.file)).toBe("Okafor - Sub Work Order (Painter).pdf");
    expect(existsSync(r.file)).toBe(true);
    expect(readFileSync(r.file).subarray(0, 5).toString()).toBe("%PDF-");
    // The color was already asked about; the ceiling wasn't, so it's added.
    expect(r.questions).toEqual(["Hall Bath: what color and sheen for the walls?", "Hall Bath: whether the ceiling gets painted?"]);
    const order = JSON.parse(readFileSync(path.join(hub.jobs.folder(6600), "estimate", "sub-work-order-painter.json"), "utf8"));
    expect(order.rooms[0].paint).toMatchObject({ walls: "The tub wall only", ceiling: "NOT SETTLED: check with Forefront before painting" });
    expect(order.rooms[0].photos).toEqual([]); // a photo number that doesn't exist is dropped
    expect(order).toMatchObject({ job_number: 6600, customer: "Okafor", trade: "Painter" });
    // What Gemini was given: the scope and the walk, no prices, and the painter-only rule.
    const sent = JSON.stringify((hub.gemini as MockGemini).requests[0]);
    expect(sent).toContain("paint the tub wall");
    expect(sent).toContain("for the Painter only");
    for (const gone of ["232.96", "1748.04", "unit_price"]) expect(sent).not.toContain(gone);
  });

  it("says so when there's nothing on the job to build it from", async () => {
    const { hub } = setup();
    hub.gemini = new MockGemini(() => "{}");
    await expect(makeSubReport(hub, 6600)).rejects.toThrow(/nothing to build a work order from/);
  });
});
