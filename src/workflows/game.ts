import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { Hub } from "../hub.js";
import type { Reminder } from "./reminders.js";

/**
 * Game mode's scorekeeping. Points come only from real work Keystone already records (each job's log, the estimate
 * PDFs it renders, the brief's ticks), so nothing new has to be entered and nothing is ever written anywhere but
 * Keystone's own .hub/game.json. Same history in, same score out: an event is counted once, by its id.
 *
 * XP -> levels and titles; daily quests; a "boss" (the job that's waited longest on Hunter: each action on it hits,
 * and it's beaten when it leaves the waiting list); badges; a weekday streak.
 */
export interface GameEvent { id: string; at: string; kind: string; xp: number; label: string; job?: number }
interface Boss { jobNumber: number; name: string; kind: string; title: string; since: string; days: number }
interface Daily { replyStart?: number; quests?: Record<string, boolean> }
interface Saved {
  startedAt: string;
  /** Events counted so far, by id (the log keeps the newest 400 for the feed; totals keep everything). */
  counted: Record<string, number>;
  feed: GameEvent[];
  totals: { xp: number; byKind: Record<string, number> };
  badges: Record<string, string>;
  boss?: Boss | null;
  bossesBeaten: number;
  days: Record<string, Daily>;
  /** Denver dates with at least one point, for the streak. */
  active: string[];
}

/** What each kind of work is worth, and how many times a day it counts (so busywork can't farm points). */
export const RULES: { kind: string; match: RegExp; xp: number; label: (m: RegExpMatchArray, what: string) => string; perDay?: number }[] = [
  { kind: "won", match: /^Homebase: stage .+ -> (Job Won|WA\/Contract Sent)/, xp: 300, label: () => "Job won!" },
  { kind: "proposal", match: /^Homebase: proposal /, xp: 150, label: () => "Proposal submitted" },
  { kind: "lost", match: /^Homebase: stage .+ -> Closed Lost/, xp: 5, label: () => "Closed out (lessons learned)" },
  { kind: "stage", match: /^Homebase: stage (.+) -> (.+?)( \(|$)/, xp: 15, label: (m) => `Moved to ${m[2]}`, perDay: 12 },
  { kind: "sendoff", match: /^Send-off drafted/, xp: 40, label: () => "Send-off ready" },
  { kind: "walk", match: /^Walk recording filed/, xp: 40, label: () => "Scouting report filed" },
  { kind: "subwo", match: /^Sub work order made/, xp: 30, label: () => "Work order for the subs" },
  { kind: "email", match: /^Emailed /, xp: 15, label: () => "Email sent", perDay: 20 },
  { kind: "draft", match: /^Draft[ (]/, xp: 10, label: () => "Email drafted", perDay: 15 },
  { kind: "itel", match: /^ITEL report/, xp: 15, label: () => "ITEL report found" },
  { kind: "selection", match: /^Selection (added|from)/, xp: 10, label: () => "Selection logged", perDay: 10 },
  { kind: "note", match: /^Homebase (note|call|meeting|text|note reply)/, xp: 10, label: () => "Logged in Homebase", perDay: 15 },
  { kind: "status", match: /^Homebase status update/, xp: 5, label: () => "Status posted for the team", perDay: 20 },
  { kind: "calendar", match: /^Calendar: /, xp: 10, label: () => "On the calendar", perDay: 10 },
  { kind: "task", match: /^Task( from email)?: /, xp: 5, label: () => "Task added", perDay: 10 },
  { kind: "upload", match: /^To Homebase: /, xp: 10, label: () => "Files to Homebase", perDay: 10 },
];
export const XP = { estimate: 60, brief: 5, quest: 50, boss: 100, bossHit: 0 };

export const TITLES = ["Apprentice", "Laborer", "Carpenter", "Lead Carpenter", "Estimator", "Senior Estimator", "Foreman", "Superintendent", "Project Boss", "Master Builder", "Keystone Legend"];
/** Total XP needed to reach a level (level 1 starts at 0): 150, 450, 900, ... */
export const xpForLevel = (lv: number) => 75 * (lv - 1) * lv;
export function levelOf(xp: number) {
  let lv = 1;
  while (xp >= xpForLevel(lv + 1)) lv++;
  return { level: lv, title: TITLES[Math.min(TITLES.length - 1, Math.floor((lv - 1) / 2))], from: xpForLevel(lv), to: xpForLevel(lv + 1) };
}

export const BADGES: { id: string; name: string; icon: string; desc: string; test: (s: Saved, ctx: { level: number; streak: number }) => boolean }[] = [
  { id: "first-proposal", name: "First Bid", icon: "scroll", desc: "Submit a proposal", test: (s) => (s.totals.byKind.proposal ?? 0) >= 1 },
  { id: "proposals-10", name: "Bid Machine", icon: "anvil", desc: "Submit 10 proposals", test: (s) => (s.totals.byKind.proposal ?? 0) >= 10 },
  { id: "proposals-50", name: "Estimating Legend", icon: "crown", desc: "Submit 50 proposals", test: (s) => (s.totals.byKind.proposal ?? 0) >= 50 },
  { id: "won-1", name: "Contract Closer", icon: "trophy", desc: "Win a job", test: (s) => (s.totals.byKind.won ?? 0) >= 1 },
  { id: "won-10", name: "Rainmaker", icon: "coin", desc: "Win 10 jobs", test: (s) => (s.totals.byKind.won ?? 0) >= 10 },
  { id: "boss-1", name: "Boss Slayer", icon: "sword", desc: "Beat a boss", test: (s) => s.bossesBeaten >= 1 },
  { id: "boss-10", name: "Dungeon Cleaner", icon: "shield", desc: "Beat 10 bosses", test: (s) => s.bossesBeaten >= 10 },
  { id: "inbox-zero", name: "Inbox Zero", icon: "envelope", desc: "Answer everyone waiting on you in a day", test: (s) => Object.values(s.days).some((d) => d.quests?.replies && (d.replyStart ?? 0) > 0) },
  { id: "clean-sweep", name: "Clean Sweep", icon: "broom", desc: "Tick off the whole brief", test: (s) => Object.values(s.days).some((d) => d.quests?.brief) },
  { id: "streak-5", name: "On a Roll", icon: "flame", desc: "5 workdays in a row", test: (_s, c) => c.streak >= 5 },
  { id: "streak-20", name: "Unstoppable", icon: "star", desc: "20 workdays in a row", test: (_s, c) => c.streak >= 20 },
  { id: "scout-10", name: "Scout", icon: "boot", desc: "File 10 walk recordings", test: (s) => (s.totals.byKind.walk ?? 0) >= 10 },
  { id: "forge-10", name: "Forge Master", icon: "hammer", desc: "Build 10 estimates", test: (s) => (s.totals.byKind.estimate ?? 0) >= 10 },
  { id: "level-5", name: "Moving Up", icon: "gem", desc: "Reach level 5", test: (_s, c) => c.level >= 5 },
  { id: "level-10", name: "Master Builder", icon: "castle", desc: "Reach level 10", test: (_s, c) => c.level >= 10 },
];

const file = (hub: Hub) => path.join(hub.cfg.stateDir, "game.json");
const dayOf = (iso: string | Date) => new Date(iso).toLocaleDateString("en-CA", { timeZone: "America/Denver" });
const hourOf = (iso: string) => Number(new Date(iso).toLocaleString("en-US", { timeZone: "America/Denver", hour: "numeric", hour12: false }));
const isWeekday = (d: string) => { const w = new Date(`${d}T12:00:00Z`).getUTCDay(); return w !== 0 && w !== 6; };

function load(hub: Hub): Saved {
  try {
    if (existsSync(file(hub))) return JSON.parse(readFileSync(file(hub), "utf8"));
  } catch { /* start again */ }
  // A new player starts with the last 30 days of real work already counted, so the board isn't empty on day one.
  return { startedAt: new Date(Date.now() - 30 * 864e5).toISOString(), counted: {}, feed: [], totals: { xp: 0, byKind: {} }, badges: {}, boss: null, bossesBeaten: 0, days: {}, active: [] };
}
function save(hub: Hub, s: Saved) {
  mkdirSync(hub.cfg.stateDir, { recursive: true });
  writeFileSync(file(hub), JSON.stringify(s));
}

/** Every countable thing that has happened since the player started, from Keystone's own records. */
export function collectEvents(hub: Hub, since: string, brief?: { startedAt?: string; done?: Record<string, boolean> } | null): GameEvent[] {
  const out: GameEvent[] = [];
  for (const job of hub.jobs.list()) {
    const n = job.jobNumber;
    for (const e of job.log ?? []) {
      if (e.at < since) continue;
      for (const r of RULES) {
        const m = e.what.match(r.match);
        if (!m) continue;
        out.push({ id: `log:${n}:${e.at}:${r.kind}`, at: e.at, kind: r.kind, xp: r.xp, label: `${r.label(m, e.what)} · #${n} ${job.name}`, job: n });
        break;
      }
    }
    // An estimate rendered (its PDFs written) counts once per job per day.
    const days = new Map<string, string>();
    for (const f of hub.jobs.files(n, "estimate", /\.pdf$/i)) {
      try {
        const at = statSync(f).mtime.toISOString();
        if (at >= since && (!days.has(dayOf(at)) || at < days.get(dayOf(at))!)) days.set(dayOf(at), at);
      } catch { /* gone */ }
    }
    for (const [d, at] of days) out.push({ id: `est:${n}:${d}`, at, kind: "estimate", xp: XP.estimate, label: `Estimate forged · #${n} ${job.name}`, job: n });
  }
  // Brief ticks: each line ticked off today's brief.
  if (brief?.startedAt && brief.done) {
    for (const [k, v] of Object.entries(brief.done)) if (v) out.push({ id: `brief:${brief.startedAt}:${k}`, at: new Date().toISOString(), kind: "brief", xp: XP.brief, label: "Brief item done" });
  }
  return out.sort((a, b) => a.at.localeCompare(b.at));
}

/** The brief's action lines (numbered or bulleted), for the "clear the brief" quest. */
export function briefLines(text: string) {
  return text.split("\n").filter((l) => /^\s*(\d+\.|[-*])\s+\S/.test(l) && !/^\s*[-*]\s*\*\*/.test(l)).length;
}

export interface Quest { id: string; title: string; progress: number; goal: number; done: boolean; xp: number; hint: string }
export interface GameState {
  xp: number; level: number; title: string; levelFrom: number; levelTo: number;
  xpToday: number; streak: number;
  quests: Quest[];
  boss: (Boss & { hp: number; hpMax: number; hits: number }) | null;
  bossesBeaten: number;
  badges: { id: string; name: string; icon: string; desc: string; earned: string | null }[];
  feed: GameEvent[];
  /** New since the `seen` the page sent: for +XP pop-ups, level-ups and new badges. */
  fresh: GameEvent[];
}

const BOSS_KINDS = new Set(["stale", "followup", "adjuster", "estimate", "reply"]);
const BOSS_HP = 3;

/**
 * Counts anything new, settles today's quests and the boss, and returns the board. `reminders` is what's waiting
 * on Hunter right now; `brief` is today's brief (text and ticks).
 */
export function gameState(hub: Hub, reminders: Reminder[], brief?: { startedAt?: string; text?: string; done?: Record<string, boolean> } | null, seen = ""): GameState {
  const s = load(hub);
  const today = dayOf(new Date());
  const fresh: GameEvent[] = [];
  const perDay = new Map<string, number>();
  for (const id of Object.keys(s.counted)) { const [, , at, kind] = id.split(":"); if (at && kind) { const k = `${kind}:${dayOf(at)}`; perDay.set(k, (perDay.get(k) ?? 0) + 1); } }
  const award = (e: GameEvent) => {
    if (s.counted[e.id] !== undefined) return;
    const rule = RULES.find((r) => r.kind === e.kind);
    const k = `${e.kind}:${dayOf(e.at)}`;
    const xp = rule?.perDay && (perDay.get(k) ?? 0) >= rule.perDay ? 0 : e.xp;
    perDay.set(k, (perDay.get(k) ?? 0) + 1);
    s.counted[e.id] = xp;
    if (!xp) return;
    const ev = { ...e, xp };
    s.totals.xp += xp;
    s.totals.byKind[e.kind] = (s.totals.byKind[e.kind] ?? 0) + 1;
    s.feed.push(ev);
    const d = dayOf(e.at);
    if (!s.active.includes(d)) s.active.push(d);
    fresh.push(ev);
  };
  const events = collectEvents(hub, s.startedAt, brief?.startedAt && dayOf(brief.startedAt) === today ? brief : null);
  for (const e of events) award(e);

  // ---- the boss: what's waited longest on Hunter. Every action on its job is a hit; it's beaten when it's off the list.
  const waiting = reminders.filter((r) => BOSS_KINDS.has(r.kind));
  const stillThere = s.boss && waiting.some((r) => r.jobNumber === s.boss!.jobNumber && r.kind === s.boss!.kind);
  if (s.boss && !stillThere) {
    s.bossesBeaten++;
    award({ id: `boss:${s.boss.jobNumber}:${s.boss.since}`, at: new Date().toISOString(), kind: "boss", xp: XP.boss, label: `Boss beaten: #${s.boss.jobNumber} ${s.boss.name}`, job: s.boss.jobNumber });
    s.boss = null;
  }
  if (!s.boss) {
    const next = [...waiting].sort((a, b) => b.days - a.days)[0];
    if (next) s.boss = { jobNumber: next.jobNumber, name: next.name, kind: next.kind, title: next.title, since: new Date().toISOString(), days: next.days };
  } else {
    const r = waiting.find((x) => x.jobNumber === s.boss!.jobNumber && x.kind === s.boss!.kind);
    if (r) s.boss.days = r.days;
  }
  const hits = s.boss ? events.filter((e) => e.job === s.boss!.jobNumber && e.at >= s.boss!.since).length : 0;

  // ---- today's quests
  const day = (s.days[today] ??= {});
  const replies = reminders.filter((r) => r.kind === "reply").length;
  if (day.replyStart === undefined) day.replyStart = replies;
  const todays = events.filter((e) => dayOf(e.at) === today);
  const touch = todays.filter((e) => ["draft", "email", "note", "calendar", "status"].includes(e.kind)).length;
  const lines = brief?.text && brief.startedAt && dayOf(brief.startedAt) === today ? briefLines(brief.text) : 0;
  const ticked = brief?.done && brief.startedAt && dayOf(brief.startedAt) === today ? Object.values(brief.done).filter(Boolean).length : 0;
  const quests: Quest[] = [
    { id: "brief", title: "Clear today's brief", progress: Math.min(ticked, lines), goal: lines || 1, done: lines > 0 && ticked >= lines, xp: XP.quest, hint: lines ? "Tick off each line on the Brief tab" : "Make today's brief first (Brief tab)" },
    // Only pays when there was someone to answer today (an empty inbox in the morning isn't a quest).
    { id: "replies", title: "Answer everyone waiting on you", progress: Math.max(0, day.replyStart - replies), goal: Math.max(1, day.replyStart), done: replies === 0, xp: day.replyStart > 0 ? XP.quest : 0, hint: replies ? `${replies} still waiting` : day.replyStart > 0 ? "Everyone's answered" : "Nobody was waiting on you today" },
    { id: "forge", title: "Forge or send an estimate", progress: Math.min(1, todays.filter((e) => e.kind === "estimate" || e.kind === "proposal" || e.kind === "sendoff").length), goal: 1, done: todays.some((e) => e.kind === "estimate" || e.kind === "proposal" || e.kind === "sendoff"), xp: XP.quest, hint: "Render an estimate or get a send-off out" },
    { id: "contact", title: "Make 3 contacts", progress: Math.min(3, touch), goal: 3, done: touch >= 3, xp: XP.quest, hint: "Drafts, emails, calls, notes or meetings" },
  ];
  day.quests ??= {};
  for (const q of quests) {
    if (q.done && !day.quests[q.id] && q.xp > 0) {
      day.quests[q.id] = true;
      award({ id: `quest:${today}:${q.id}`, at: new Date().toISOString(), kind: "quest", xp: q.xp, label: `Quest complete: ${q.title}` });
    }
  }

  // ---- streak: workdays in a row with points (today counts once it has some)
  const active = new Set(s.active);
  let streak = 0;
  for (let d = new Date(), first = true; ; d = new Date(d.getTime() - 864e5), first = false) {
    const k = dayOf(d);
    if (!isWeekday(k)) continue;
    if (active.has(k)) streak++;
    else if (!first) break;
    if (streak > 400) break;
  }

  const lv = levelOf(s.totals.xp);
  for (const b of BADGES) {
    if (!s.badges[b.id] && b.test(s, { level: lv.level, streak })) {
      s.badges[b.id] = new Date().toISOString();
      fresh.push({ id: `badge:${b.id}`, at: s.badges[b.id], kind: "badge", xp: 0, label: `Badge earned: ${b.name}` });
    }
  }
  s.feed = s.feed.slice(-400);
  // Old days only matter for badges already earned; keep a few months.
  for (const k of Object.keys(s.days)) if (k < dayOf(new Date(Date.now() - 120 * 864e5))) delete s.days[k];
  s.active = s.active.filter((d) => d >= dayOf(new Date(Date.now() - 500 * 864e5)));
  save(hub, s);

  const xpToday = s.feed.filter((e) => dayOf(e.at) === today).reduce((t, e) => t + e.xp, 0);
  return {
    xp: s.totals.xp, level: lv.level, title: lv.title, levelFrom: lv.from, levelTo: lv.to, xpToday, streak,
    quests,
    boss: s.boss ? { ...s.boss, hits, hpMax: BOSS_HP, hp: Math.max(1, BOSS_HP - hits) } : null,
    bossesBeaten: s.bossesBeaten,
    badges: BADGES.map((b) => ({ id: b.id, name: b.name, icon: b.icon, desc: b.desc, earned: s.badges[b.id] ?? null })),
    feed: s.feed.slice(-25).reverse(),
    fresh: seen ? fresh.filter((e) => e.at > seen || e.kind === "badge" || e.kind === "quest" || e.kind === "boss") : [],
  };
}

/** Early-bird and night-owl fun facts aren't scored; this is just for the feed's time label. */
export const timeOfDay = (iso: string) => (hourOf(iso) < 7 ? "early" : hourOf(iso) >= 19 ? "late" : "");
