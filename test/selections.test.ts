import { describe, expect, it } from "vitest";
import { looksLikePick } from "../src/agent/selections.js";
import { addPick, compare, loadSelections, parseProductPage, setCategories, summary, updateSelection } from "../src/workflows/selections.js";
import { testHub } from "./helpers.js";

describe("selections", () => {
  it("compares picks against the material budget and keeps them when the list is rebuilt", () => {
    const { hub } = testHub();
    hub.jobs.upsert(3226, { name: "Augustine" });
    const s = setCategories(hub, 3226, [{ name: "LVP flooring", room: "Hallway, Bedroom 2", quantity: 220, unit: "SF", budgetPerUnit: 2.5, budgetTotal: 0, basis: "component cost" }], "estimate.json");
    const cat = s.categories[0];
    expect(cat.budgetTotal).toBe(550);
    const p = addPick(hub, 3226, cat.id, { product: "Lorraine Sienna LVP", pricePerUnit: 2.99, source: "email", from: "Eileen <e@example.com>" });
    expect(compare(cat, p)).toEqual({ total: 657.8, diff: 107.8, pct: 20, verdict: "over" });
    expect(loadSelections(hub, 3226).categories[0].status).toBe("selected");
    setCategories(hub, 3226, [{ name: "LVP flooring", room: "Hallway, Bedroom 2", quantity: 230, unit: "SF", budgetPerUnit: 2.6, budgetTotal: 0 }], "estimate.json");
    const again = loadSelections(hub, 3226).categories[0];
    expect(again.picks.map((x) => x.product)).toEqual(["Lorraine Sienna LVP"]);
    expect(summary(loadSelections(hub, 3226))).toMatchObject({ budget: 598, picked: 687.7, diff: 89.7, open: 0, over: 1 });
    updateSelection(hub, 3226, { categoryId: again.id, pickId: again.picks[0].id, remove: true });
    expect(loadSelections(hub, 3226).categories[0].status).toBe("needed");
  });

  it("reads a product page's name, photo and price", () => {
    const html = `<html><head><title>x</title><meta property="og:image" content="/img/lvp.jpg">
      <script type="application/ld+json">{"@context":"https://schema.org","@type":"Product","name":"DuraLux Lorraine Sienna 7 in LVP","brand":{"@type":"Brand","name":"DuraLux"},"sku":"101058436","offers":{"@type":"Offer","price":"2.99","priceCurrency":"USD"}}</script></head></html>`;
    expect(parseProductPage(html, "https://www.flooranddecor.com/p/101058436")).toEqual({ title: "DuraLux Lorraine Sienna 7 in LVP", image: "https://www.flooranddecor.com/img/lvp.jpg", price: 2.99, priceText: "$2.99", brand: "DuraLux", sku: "101058436" });
  });

  it("only asks Claude about emails that look like a pick", () => {
    const m = (body: string, attachments: any[] = []) => ({ id: "1", from: "a@b.c", to: [], cc: [], date: "", subject: "Flooring", body, attachments });
    expect(looksLikePick(m("We picked this one: https://www.homedepot.com/p/123"))).toBe(true);
    expect(looksLikePick(m("Here's the tile we like", [{ id: "x", filename: "tile.jpg", mimeType: "image/jpeg" }]))).toBe(true);
    expect(looksLikePick(m("Thanks, see you Tuesday"))).toBe(false);
  });
});
