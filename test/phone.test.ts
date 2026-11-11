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
});
