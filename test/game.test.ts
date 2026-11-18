import { describe, expect, it } from "vitest";
import { briefLines, gameState, levelOf, xpForLevel } from "../src/workflows/game.js";
import type { Reminder } from "../src/workflows/reminders.js";
import { testHub } from "./helpers.js";

const ago = (h: number) => new Date(Date.now() - h * 3600e3).toISOString();
function setup() {
  const t = testHub();
  const log = (n: number, what: string, h: number) => {
    if (!t.hub.jobs.exists(n)) t.hub.jobs.upsert(n, { name: `Job${n}`, address: "1 Test St" });
    const j = t.hub.jobs.get(n);
    t.hub.jobs.upsert(n, { log: [...j.log, { at: ago(h), what }] });
  };
  return { ...t, log };
}
const rem = (o: Partial<Reminder>): Reminder => ({ kind: "stale", jobNumber: 1, name: "Job1", stage: "Proposal Submitted", title: "Proposal out", detail: "", days: 9, step: "", ...o });

describe("game mode's score", () => {
  it("levels up on a rising curve with titles", () => {
    expect(xpForLevel(1)).toBe(0); expect(xpForLevel(2)).toBe(150); expect(xpForLevel(3)).toBe(450);
    expect(levelOf(0)).toMatchObject({ level: 1, title: "Apprentice" });
    expect(levelOf(460)).toMatchObject({ level: 3, title: "Laborer", from: 450, to: 900 });
  });

  it("scores real work from the job logs once, with daily caps on small stuff", () => {
    const { hub, log } = setup();
    log(1, "Homebase: proposal $10,000.00 on 2026-11-18", 3);
    log(1, "Homebase: stage Proposal Submitted -> Job Won", 2);
    log(2, "Walk recording filed: kitchen", 1);
    for (let i = 0; i < 20; i++) log(3, `Draft "Re: ${i}" to a@example.com`, 0.5 + i / 100);
    log(3, "Pulled from Homebase", 1); // not work: no points
    const s = gameState(hub, []);
    // drafts count 15 times a day; today's work also completes the estimate and contacts quests (+50 each)
    expect(s.xp).toBe(150 + 300 + 40 + 15 * 10 + 50 + 50);
    expect(s.feed.find((f) => f.kind === "won")!.label).toBe("Job won! · #1 Job1");
    expect(gameState(hub, []).xp).toBe(s.xp); // counted once
    expect(s.badges.find((b) => b.id === "first-proposal")!.earned).toBeTruthy();
    expect(s.badges.find((b) => b.id === "won-1")!.earned).toBeTruthy();
    expect(s.streak).toBeGreaterThanOrEqual(new Date().getDay() % 6 === 0 ? 0 : 1);
  });

  it("makes the longest-waiting job the boss, counts hits on it, and pays out when it's cleared", () => {
    const { hub, log } = setup();
    log(5, "Homebase note: started", 1);
    let s = gameState(hub, [rem({ jobNumber: 4, name: "Short", days: 3 }), rem({ jobNumber: 5, name: "Williams", days: 21, kind: "followup" })]);
    expect(s.boss).toMatchObject({ jobNumber: 5, name: "Williams", hp: 3, hits: 0 });
    log(5, 'Draft "Checking in" to w@example.com', 0);
    s = gameState(hub, [rem({ jobNumber: 4, name: "Short", days: 3 }), rem({ jobNumber: 5, name: "Williams", days: 21, kind: "followup" })]);
    expect(s.boss!.hits).toBe(1);
    expect(s.boss!.hp).toBe(2);
    const before = s.xp;
    s = gameState(hub, [rem({ jobNumber: 4, name: "Short", days: 3 })]);
    expect(s.bossesBeaten).toBe(1);
    expect(s.xp).toBe(before + 100);
    expect(s.boss).toMatchObject({ jobNumber: 4 });
    expect(s.badges.find((b) => b.id === "boss-1")!.earned).toBeTruthy();
  });

  it("runs today's quests from the brief, the waiting list and the day's work", () => {
    const { hub, log } = setup();
    const brief = { startedAt: new Date().toISOString(), text: "**Do in this order**\n1. #1 Job1: reply {go:1:job}\n2. #2 Job2: send it\n\n**My tasks**\n- Order tile {task:T1}", done: {} as Record<string, boolean> };
    expect(briefLines(brief.text)).toBe(3);
    let s = gameState(hub, [rem({ kind: "reply", jobNumber: 1 })], brief);
    expect(s.quests.find((q) => q.id === "brief")).toMatchObject({ progress: 0, goal: 3, done: false });
    expect(s.quests.find((q) => q.id === "replies")).toMatchObject({ goal: 1, done: false });
    brief.done = { a: true, b: true, c: true };
    log(1, "Emailed a@example.com: Re: estimate", 0); log(1, "Homebase call: adjuster", 0); log(2, 'Draft "x" to b@example.com', 0);
    const before = s.xp;
    s = gameState(hub, [], brief);
    expect(s.quests.every((q) => q.done || q.id === "forge")).toBe(true);
    // 3 brief ticks (5 each) + 3 contacts (15 + 10 + 10) + quests: brief, replies, contacts (50 each), and the
    // reply job was the boss, beaten now it's answered (+100)
    expect(s.xp - before).toBe(15 + 35 + 150 + 100);
    expect(s.badges.find((b) => b.id === "clean-sweep")!.earned).toBeTruthy();
    expect(s.badges.find((b) => b.id === "inbox-zero")!.earned).toBeTruthy();
  });

  it("doesn't pay the inbox quest on a day nobody was waiting", () => {
    const { hub } = setup();
    const s = gameState(hub, []);
    expect(s.quests.find((q) => q.id === "replies")).toMatchObject({ done: true, xp: 0 });
    expect(s.xp).toBe(0);
  });
});

describe("game mode's art from Little Town", () => {
  it("has every strip and building the page asks for, with credits", async () => {
    const { existsSync, readFileSync } = await import("node:fs");
    const dir = "src/server/game-art";
    const art = JSON.parse(readFileSync(`${dir}/art.json`, "utf8"));
    for (const n of ["hero_hammer", "hero_idle", ...["werewolf", "lich", "vampire", "orc"].flatMap((b) => [`boss_${b}_idle`, `boss_${b}_death`])]) {
      expect(art.strips[n], n).toBeTruthy();
      expect(existsSync(`${dir}/${n}.png`), n).toBe(true);
    }
    const page = readFileSync("src/server/game.js", "utf8");
    for (const b of [...page.matchAll(/\["([a-z_]+)", \d+\]/g)].map((m) => m[1]).concat(["signpost", "watchtower", "workshop", "market_stall", "tavern", "stockpile", "cottage"])) {
      expect(art.buildings[b], b).toBeTruthy();
      expect(existsSync(`${dir}/b_${b}.png`), b).toBe(true);
    }
    expect(existsSync(`${dir}/town.ogg`)).toBe(true);
    expect(readFileSync(`${dir}/CREDITS.md`, "utf8")).toMatch(/Little Town/);
  });
});
