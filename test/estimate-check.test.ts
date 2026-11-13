import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { MockGemini } from "../src/connectors/gemini/index.js";
import { Studio } from "../src/agent/studio.js";
import { checkEstimate, checkFacts, checkText } from "../src/workflows/estimateCheck.js";
import { ESTIMATOR_DIR, testHub } from "./helpers.js";

const SKILL = path.join(ESTIMATOR_DIR, "skill", "forefront-estimate");
/** A real row from the skill's price list, so the test follows the price file as it changes. */
function listRow() {
  const [head, ...rows] = readFileSync(path.join(SKILL, "references", "xactimate_prices.csv"), "utf8").split("\n").map((l) => l.split(","));
  const c = (n: string) => head.indexOf(n);
  const r = rows.find((x) => x.length === head.length && x[c("unit")] === "SF" && Number(x[c("price")]) > 0 && !x[c("description")].includes('"'))!;
  return { description: r[c("description")], unit: r[c("unit")], price: Number(r[c("price")]), list: r[c("price_list")] };
}
function setup() {
  const t = testHub();
  t.hub.cfg.skillDir = SKILL;
  t.hub.cfg.ai = { provider: "gemini", geminiKey: "k", geminiModel: "main", geminiFastModel: "fast" };
  t.hub.jobs.upsert(6700, { name: "Sample", address: "123 Main St, Denver, CO" });
  const put = (rel: string, text: string) => { const f = path.join(t.hub.jobs.folder(6700), rel); mkdirSync(path.dirname(f), { recursive: true }); writeFileSync(f, text); };
  return { ...t, put };
}
const estimate = (items: object[], row = listRow()) => ({ price_list: row.list, rooms: [{ name: "Hall Bath", floor_sf: 40, wall_sf: 208, ceiling_sf: 40, floor_perimeter_lf: 26 }], sections: [{ name: "Hall Bath", items }] });

describe("Keystone's free check of an estimate", () => {
  it("passes a line priced exactly from the job's price list", () => {
    const { hub } = setup();
    const row = listRow();
    const r = checkFacts(hub, estimate([{ description: row.description, quantity: 10, unit: row.unit, unit_price: row.price, price_source: "price_list" }]));
    expect(r).toMatchObject({ lines: 1, pricesOk: 1 });
    expect(r.findings.filter((f) => f.level === "wrong")).toEqual([]);
  });

  it("catches a wrong price, a zero quantity, a missing unit, a doubled line and more floor than the room has", () => {
    const { hub } = setup();
    const row = listRow();
    const r = checkFacts(hub, estimate([
      { description: row.description, quantity: 10, unit: row.unit, unit_price: row.price + 1, price_source: "price_list" },
      { description: row.description, quantity: 0, unit: row.unit, unit_price: row.price, price_source: "price_list" },
      { description: "Made-up floor covering nobody sells", quantity: 400, unit: "SF", unit_price: 3, price_source: "price_list" },
      { description: "Something with no unit", quantity: 1, unit: "", unit_price: 5, price_source: "estimated" },
    ]));
    const all = r.findings.map((f) => `${f.level}: ${f.what}`).join("\n");
    expect(all).toMatch(new RegExp(`wrong: .*is priced \\$${(row.price + 1).toFixed(2)}; the ${row.list} list says \\$${row.price.toFixed(2)}`));
    expect(all).toMatch(/wrong: .*has a quantity of 0/);
    expect(all).toMatch(/wrong: .*has no unit/);
    expect(all).toMatch(/look: .*400 SF is more than the room's floor \(40 SF\)/);
    expect(all).toMatch(/look: .*isn't in the price list or the price book/);
    expect(all).toMatch(/look: .*is on the list 2 times/);
    expect(all).toMatch(/look: .*priced by estimate/);
    expect(checkText({ at: "", ...r, review: [], reviewNote: "" })).toMatch(/\*\*Looks wrong \(\d\)\*\*/);
  });

  it("has Gemini compare the scope with what was said, never seeing a price", async () => {
    const { hub, put } = setup();
    const row = listRow();
    put("estimate/estimate.json", JSON.stringify(estimate([{ description: row.description, quantity: 10, unit: row.unit, unit_price: row.price, price_source: "price_list" }])));
    put("notes/notes.txt", "Homeowner also wants the hallway closet repainted.");
    hub.gemini = new MockGemini(() => JSON.stringify({ findings: [{ level: "wrong", where: "Hallway closet", what: "The notes say to repaint the hallway closet; the estimate has no closet." }] }));
    const c = (await checkEstimate(hub, 6700))!;
    expect(c.review).toEqual([{ level: "wrong", where: "Hallway closet", what: "The notes say to repaint the hallway closet; the estimate has no closet." }]);
    const sent = JSON.stringify((hub.gemini as MockGemini).requests[0]);
    expect(sent).toContain("hallway closet repainted");
    expect(sent).not.toContain("unit_price");
    expect(checkText(c)).toContain("**Hallway closet:** The notes say to repaint");
  });

  it("runs by itself after the estimator writes an estimate, and shows up in the conversation", async () => {
    const { hub } = setup();
    const row = listRow();
    const json = JSON.stringify(estimate([{ description: row.description, quantity: 10, unit: row.unit, unit_price: row.price + 2, price_source: "price_list" }]));
    const script = [{ calls: [{ name: "write_file", args: { path: "estimate/estimate.json", content: json } }] }, { text: "Estimate written." }, JSON.stringify({ findings: [] })];
    hub.gemini = new MockGemini((_r, n) => script[n] as never);
    const studio = new Studio(hub, () => {});
    await studio.send(6700, "New estimate", "gemini");
    const check = studio.view(6700).turns.find((t) => t.role === "check");
    expect(check?.text).toMatch(/Keystone's check \(free, no Claude used\)/);
    expect(check?.text).toMatch(/Looks wrong \(1\)/);
    // A message that doesn't touch the estimate doesn't trigger another check.
    hub.gemini = new MockGemini(() => "Nothing to change.");
    await studio.send(6700, "Thanks", "gemini");
    expect(studio.view(6700).turns.filter((t) => t.role === "check")).toHaveLength(1);
  });
});
