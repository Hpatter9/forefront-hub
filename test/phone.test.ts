import { createDecipheriv, pbkdf2Sync } from "node:crypto";
import { createRequire } from "node:module";
import { describe, expect, it } from "vitest";
import { lockSetup, phoneSetup, servePairing } from "../src/workflows/phone.js";
import { testHub } from "./helpers.js";

const K = createRequire(import.meta.url)("../phone/assets/app.js");

/** What the phone app does with the laptop's locked setup and the typed code. */
function unlock(box: ReturnType<typeof lockSetup>, code: string) {
  const data = Buffer.from(box.data, "base64");
  const aes = createDecipheriv("aes-256-gcm", pbkdf2Sync(code, Buffer.from(box.salt, "base64"), box.rounds, 32, "sha256"), Buffer.from(box.iv, "base64"));
  aes.setAuthTag(data.subarray(data.length - 16));
  return JSON.parse(Buffer.concat([aes.update(data.subarray(0, data.length - 16)), aes.final()]).toString("utf8"));
}

describe("connecting the phone", () => {
  it("hands over the setup locked with the code: the right code opens it, a wrong one doesn't", async () => {
    const { hub } = testHub();
    const s = await servePairing(hub, { port: 0, code: "482913" });
    try {
      const box = await (await fetch(`http://127.0.0.1:${s.port}/pair`)).json();
      expect(JSON.stringify(box)).not.toContain("482913");
      expect(JSON.stringify(box)).not.toContain(hub.cfg.homebase.url);
      const setup = unlock(box, "482913");
      expect(setup).toMatchObject({ homebase: { url: hub.cfg.homebase.url }, me: { name: hub.cfg.homebase.me } });
      expect(() => unlock(box, "482914")).toThrow();
      expect(await (await fetch(`http://127.0.0.1:${s.port}/`)).text()).toContain("Keystone for your phone");
      expect((await fetch(`http://127.0.0.1:${s.port}/pair`, { method: "POST" })).status).toBe(405);
    } finally {
      s.server.close();
    }
  });

  it("sends a copy of the contacts that have a number or an email", () => {
    const { hub } = testHub();
    expect(phoneSetup(hub).contacts.every((c) => c.name && (c.phones.length || c.emails.length))).toBe(true);
  });
});

describe("the phone app's logic", () => {
  const setup = { homebase: { url: "https://hb.example", token: "tok" }, me: { name: "Hunter Patterson", email: "hunter@example.com" }, google: { clientId: "id", clientSecret: "sec", refreshToken: "ref" }, gemini: { key: "k", model: "m1", fallbacks: ["m2"] }, contacts: [{ name: "Heather Hanley", company: "Westwind HOA", emails: ["heather@example.com"], phones: ["7205550142"], jobs: [{ jobNumber: 6001, name: "Forbes", role: "Property manager" }] }] };
  /** A phone with canned answers from Gemini (in order) and a pretend Homebase and Google. */
  function phone(answers: any[], yes = true) {
    const sent: { method: string; url: string; headers: Record<string, string>; body?: string }[] = [];
    const store: Record<string, string> = { setup: JSON.stringify(setup) };
    const asked: string[] = [];
    const io = {
      get: (k: string) => store[k] ?? "",
      set: (k: string, v: string) => void (store[k] = v),
      confirm: async (title: string) => { asked.push(title); return yes; },
      http: async (r: any) => {
        sent.push(r);
        const ok = (o: unknown) => ({ status: 200, body: JSON.stringify(o) });
        if (r.url.includes("generativelanguage")) return ok({ candidates: [{ content: { role: "model", parts: answers.shift() } }] });
        if (r.url.includes("/projects?")) return ok({ projects: [{ id: "p1", jobNumber: 6001, name: "Forbes", address: "412 Maple St", stage: "Estimating" }] });
        if (r.url.includes("oauth2.googleapis.com")) return ok({ access_token: "at", expires_in: 3600 });
        return ok({ ok: true, contacts: [] });
      },
    };
    return { k: K.create(io), sent, asked };
  }

  it("turns a spoken update into a Homebase note, after a yes", async () => {
    const p = phone([[{ functionCall: { name: "find_jobs", args: { query: "Forbes" } } }], [{ functionCall: { name: "add_note", args: { jobNumber: 6001, body: "Homeowner approved the tile." } } }], [{ text: "Added the note to Forbes." }]]);
    const r = await p.k.ask("tell homebase the forbes homeowner approved the tile", []);
    expect(r.text).toBe("Added the note to Forbes.");
    expect(p.asked).toEqual(["Add this note to #6001 in Homebase?"]);
    const post = p.sent.find((x) => x.method === "POST" && x.url === "https://hb.example/api/v1/projects/p1/notes")!;
    expect(JSON.parse(post.body!)).toMatchObject({ body: "Homeowner approved the tile." });
    expect(post.headers).toMatchObject({ Authorization: "Bearer tok", "X-Acting-User-Email": "hunter@example.com" });
    expect(r.history.at(-1).role).toBe("model");
  });

  it("writes nothing when the answer is no", async () => {
    const p = phone([[{ functionCall: { name: "add_note", args: { jobNumber: 6001, body: "x" } } }], [{ text: "Okay, I left it." }]], false);
    await p.k.ask("add a note", []);
    expect(p.sent.some((x) => x.method === "POST" && x.url.includes("/notes"))).toBe(false);
  });

  it("finds a contact Hunter named in Keystone, with a tappable number", async () => {
    const p = phone([]);
    expect(await p.k.findContact("heather")).toEqual([expect.objectContaining({ name: "Heather Hanley", phones: ["(720) 555-0142"], from: "Keystone" })]);
  });

  it("email is a Gmail draft copied to the job's Homebase address, and calendar invites go out only after a yes", async () => {
    const p = phone([]);
    await p.k.gmailDraft({ to: ["dana@example.com"], subject: "Tile", body: "Hi Dana,\nThe tile is in.", jobNumber: 6001 });
    const d = p.sent.find((x) => x.url.endsWith("/users/me/drafts"))!;
    const raw = Buffer.from(JSON.parse(d.body!).message.raw, "base64url").toString("utf8");
    expect(raw).toContain("To: dana@example.com");
    expect(raw).toContain("Bcc: office+6001@forefrontteam.com");
    expect(p.sent.some((x) => /messages\/send/.test(x.url))).toBe(false);
    const no = phone([[{ functionCall: { name: "calendar_create", args: { title: "Forbes walk", start: "2026-11-12T10:00:00", end: "2026-11-12T11:00:00", attendees: ["dana@example.com"] } } }], [{ text: "Left it off." }]], false);
    await no.k.ask("set up a walk", []);
    expect(no.sent.some((x) => x.url.includes("calendar/v3"))).toBe(false);
  });

  it("changes a job's stage only after a yes, with Homebase's own stage name; Closed Lost stays on the laptop", async () => {
    const stageCalls: string[] = [];
    const mk = (answers: any[], yes: boolean) => {
      const p = phone(answers, yes);
      const http = (p.k as any);
      return { ...p, http };
    };
    const sent: any[] = [];
    const store: Record<string, string> = { setup: JSON.stringify(setup) };
    let yes = true;
    const io = {
      get: (k: string) => store[k] ?? "", set: (k: string, v: string) => void (store[k] = v), confirm: async (t: string) => { stageCalls.push(t); return yes; },
      http: async (r: any) => {
        sent.push(r);
        const ok = (o: unknown) => ({ status: 200, body: JSON.stringify(o) });
        if (r.url.endsWith("/vocabulary")) return ok({ stages: ["Lead", "Scope Walk Scheduled", "Estimating", "Closed Lost"] });
        if (r.url.includes("/projects?")) return ok({ projects: [{ id: "p1", jobNumber: "6001", name: "Forbes", stage: "Lead", address: { street: "412 Maple St", city: "Denver", state: "CO", zip: "80211" } }] });
        if (r.url.endsWith("/projects/p1")) return ok({ project: { id: "p1", jobNumber: "6001", name: "Forbes", stage: "Lead", people: { estimator: "Hunter Patterson" }, dates: { stageChanged: new Date(Date.now() - 5 * 864e5).toISOString() } } });
        return ok({ ok: true });
      },
    };
    void mk;
    const k = K.create(io);
    const tool = k.tools.find((t: any) => t.decl.name === "set_stage");
    expect(await tool.run({ jobNumber: 6001, stage: "scope walk scheduled" })).toMatchObject({ done: true, from: "Lead", to: "Scope Walk Scheduled" });
    expect(stageCalls).toEqual(["Move #6001 to Scope Walk Scheduled in Homebase?"]);
    expect(JSON.parse(sent.find((x) => x.method === "PATCH").body)).toEqual({ stage: "Scope Walk Scheduled", fromStage: "Lead" });
    yes = false;
    const before = sent.filter((x) => x.method === "PATCH").length;
    expect(await tool.run({ jobNumber: 6001, stage: "Estimating" })).toMatchObject({ done: false });
    expect((await tool.run({ jobNumber: 6001, stage: "Sold" })).error).toMatch(/isn't a Homebase stage/);
    await expect(k.setStage(6001, "Closed Lost")).rejects.toThrow(/laptop/);
    expect(sent.filter((x) => x.method === "PATCH").length).toBe(before);
    // The job list knows which jobs are his, shows the address as text, and is kept on the phone for the day.
    const jobs = await k.myJobs(true);
    expect(jobs).toEqual([expect.objectContaining({ jobNumber: 6001, mine: true, address: "412 Maple St, Denver, CO 80211", stage: "Lead" })]);
    expect(JSON.parse(store.myJobs).jobs).toHaveLength(1);
  });

  it("today's list keeps going when one part can't be read, and shop stock comes from the copy on the phone", async () => {
    const store: Record<string, string> = { setup: JSON.stringify({ ...setup, google: null, stock: [{ type: "LVP / LVT", product: "Sample plank", color: "Oak", amount: "20 boxes", location: "Shop", status: "", notes: "" }, { type: "Tile", product: "Sample tile", color: "Sand", amount: "", location: "Shop", status: "", notes: "" }] }) };
    const io = {
      get: (k: string) => store[k] ?? "", set: (k: string, v: string) => void (store[k] = v), confirm: async () => true,
      http: async (r: any) => {
        const ok = (o: unknown) => ({ status: 200, body: JSON.stringify(o) });
        if (r.url.includes("/projects?")) return ok({ projects: [{ id: "p1", jobNumber: "6001", name: "Forbes", stage: "Proposal Submitted" }, { id: "p2", jobNumber: "6002", name: "Tollas", stage: "Lead" }] });
        if (/\/projects\/p\d$/.test(r.url)) return ok({ project: { id: r.url.slice(-2), jobNumber: r.url.endsWith("p1") ? "6001" : "6002", name: r.url.endsWith("p1") ? "Forbes" : "Tollas", stage: r.url.endsWith("p1") ? "Proposal Submitted" : "Lead", people: { estimator: "Hunter Patterson" }, dates: { stageChanged: new Date(Date.now() - 3 * 864e5).toISOString() }, money: { proposalAmount: 18450 } } });
        return ok({});
      },
    };
    const k = K.create(io);
    const d = await k.today(true);
    expect(d.calendar.problem).toMatch(/Google isn't connected/);
    expect(d.tasks.problem).toMatch(/Google isn't connected/);
    expect(d.leads.items.map((j: any) => [j.jobNumber, j.days])).toEqual([[6002, 3]]);
    expect(d.proposals.items.map((j: any) => [j.jobNumber, j.proposalAmount])).toEqual([[6001, 18450]]);
    expect(k.findStock("lvp oak").map((x: any) => x.product)).toEqual(["Sample plank"]);
    expect(k.findStock("")).toHaveLength(2);
  });

  it("my day is one short list, most pressing first, and a line ticked off stays off for the day", async () => {
    const store: Record<string, string> = { setup: JSON.stringify({ ...setup, google: null }) };
    const io = {
      get: (k: string) => store[k] ?? "", set: (k: string, v: string) => void (store[k] = v), confirm: async () => true,
      http: async (r: any) => {
        const ok = (o: unknown) => ({ status: 200, body: JSON.stringify(o) });
        const P: Record<string, any> = { p1: ["6001", "Forbes", "Proposal Submitted", 6], p2: ["6002", "Tollas", "Lead", 3], p3: ["6003", "Greene", "Proposal Submitted", 1] };
        if (r.url.includes("/projects?")) return ok({ projects: Object.entries(P).map(([id, v]) => ({ id, jobNumber: v[0], name: v[1], stage: v[2] })) });
        const m = r.url.match(/\/projects\/(p\d)$/);
        if (m) { const v = P[m[1]]; return ok({ project: { id: m[1], jobNumber: v[0], name: v[1], stage: v[2], people: { estimator: "Hunter Patterson" }, dates: { stageChanged: new Date(Date.now() - v[3] * 864e5).toISOString() } } }); }
        return ok({});
      },
    };
    const k = K.create(io);
    const d = await k.dayList(true);
    expect(d.items.map((x: any) => [x.title, x.sub])).toEqual([["Book a walk with Tollas", "Lead · 3 days"], ["Follow up with Forbes", "Proposal out 6 days"], ["Follow up with Greene", "Proposal out 1 day"]]);
    expect(d.problems[0]).toMatch(/Google isn't connected/);
    k.markDone(d.items[0].id, true);
    expect((await k.dayList(false)).items.map((x: any) => x.jobNumber)).toEqual([6001, 6003]);
    k.markDone(d.items[0].id, false);
    expect((await k.dayList(false)).items).toHaveLength(3);
  });
});
