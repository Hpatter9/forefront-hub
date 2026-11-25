import { describe, expect, it } from "vitest";
import { asLater } from "../src/core/approval.js";
import { EventBus, WebApprover } from "../src/server/events.js";

describe("background cards wait in To review", () => {
  it("marks a card asked from background work as later and keeps it open for days; a pressed one pops up", async () => {
    const bus = new EventBus();
    const seen: any[] = [];
    bus.emit = (e: any) => void seen.push(e);
    const ap = new WebApprover(bus, 50, 10_000);
    const now = ap.confirm("Pressed just now?", []);
    const bg = asLater(() => ap.confirm("Found on its own?", []));
    const cards = seen.filter((e) => e.type === "approval");
    expect(cards.map((c) => [c.action, !!c.later])).toEqual([["Pressed just now?", false], ["Found on its own?", true]]);
    // The pressed one times out (as a No) after its short wait; the background one is still waiting.
    expect(await now).toBe(false);
    let settled = false; void bg.then(() => (settled = true));
    await new Promise((r) => setTimeout(r, 120));
    expect(settled).toBe(false);
    ap.answer(cards[1].id, true);
    expect(await bg).toBe(true);
  });
});
