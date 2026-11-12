import { cpSync, mkdtempSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { readXlsx } from "../src/core/xlsx.js";
import { findStock, inventory, inventoryNote, stockFor, stockForJob, stockLine } from "../src/workflows/inventory.js";
import { testHub } from "./helpers.js";

const FIXTURE = path.resolve("fixtures", "inventory");
function setup(withFile = true) {
  const t = testHub();
  t.hub.cfg.hubRoot = mkdtempSync(path.join(os.tmpdir(), "inv-"));
  if (withFile) cpSync(FIXTURE, path.join(t.hub.cfg.hubRoot, "inventory"), { recursive: true });
  return t.hub;
}

describe("the shop's overstock", () => {
  it("reads an Excel workbook: sheets, text, numbers and blanks in the right columns", () => {
    const sheets = readXlsx(path.join(FIXTURE, "Shop Inventory.xlsx"));
    expect(sheets.map((s) => s.name)).toEqual(["Available to Sell", "Cove Base", "Tossed"]);
    expect(sheets[0].rows[1].slice(0, 8)).toEqual([1, "LVP / LVT", null, 'Sample Floors 7" x 48" plank', "Honey Oak", "SF-100", 20, 18.5]);
    expect(sheets[0].rows[1][10]).toBe("Rigid core & 12 mil.");
  });

  it("lists what's on the shelf with amounts, and leaves out what was tossed or isn't ours", () => {
    const hub = setup();
    const inv = inventory(hub);
    expect(inv.items.map((x) => x.item)).toEqual(["LVP / LVT 1", "Tile 2", "Tile 3", "Paint 4", "Cove Base 1"]);
    expect(stockLine(inv.items[0])).toBe('LVP / LVT: Sample Floors 7" x 48" plank, Honey Oak (20 boxes, 370 sq ft)');
    expect(stockLine(inv.items[2])).toContain("not counted yet");
    expect(inv.items[4]).toMatchObject({ product: 'Sample rubber cove base roll, 4"', amount: "3 rolls, 360 linear ft", status: "Keep for stock" });
    expect(findStock(hub, "tile sand").map((x) => x.sku)).toEqual(["ST-200"]);
  });

  it("offers the kinds of stock a job's scope talks about, and what's noted for that customer", () => {
    const hub = setup();
    expect(stockFor(hub, "Remove and replace vinyl plank in the kitchen. Paint the walls.").map((k) => [k.kind, k.items.length])).toEqual([["vinyl plank / LVT", 1], ["paint", 1]]);
    expect(stockFor(hub, "Replace the dishwasher supply line")).toEqual([]);
    hub.jobs.upsert(6200, { name: "Okafor", customer: { name: "Sam Okafor", email: "", phone: "", company: "", attention: "" } });
    hub.jobs.upsert(6201, { name: "Rivera" });
    expect(stockForJob(hub, 6200).named.map((x) => x.product)).toEqual(["Shower tile (not identified)"]);
    expect(stockForJob(hub, 6201)).toMatchObject({ kinds: [], named: [] });
    expect(inventoryNote(hub)).toContain("shop_stock");
  });

  it("says where to put the file when there isn't one, and stays quiet otherwise", () => {
    const hub = setup(false);
    expect(inventory(hub).problem).toMatch(/Save the shop's inventory spreadsheet/);
    expect(inventoryNote(hub)).toBe("");
    expect(stockFor(hub, "tile")).toEqual([]);
  });
});
