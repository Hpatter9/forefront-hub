import { existsSync, mkdirSync, mkdtempSync, readFileSync, utimesSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { MockGemini } from "../src/connectors/gemini/index.js";
import { timeline } from "../src/workflows/timeline.js";
import { fileWalk, jobWalks, matchWalk, offerWalkFollowups, recordedAt, scanWalks, transcribe, walks, type WalkNotes } from "../src/workflows/walks.js";
import { testHub } from "./helpers.js";

const notes = (o: Partial<WalkNotes> = {}): WalkNotes => ({ transcript: "Note: hall bath, ceiling drywall is down about four by six.\nCustomer: We'd like LVP in the hallway.\nHunter: I'll send the estimate by Friday.", summary: "Walked the hall bath and hallway. Ceiling drywall is down; customer wants LVP in the hall.", rooms: [{ room: "Hall bath", notes: "Ceiling drywall down approx 4x6; replace and texture." }], measurements: ["Ceiling opening about 4 ft x 6 ft"], customerWants: ["LVP in the hallway"], promises: [{ what: "Send the estimate", due: "Friday" }], ...o });

function setup() {
  const t = testHub();
  const dir = mkdtempSync(path.join(os.tmpdir(), "walkrec-"));
  t.hub.cfg.walks = { dir, since: "" };
  t.hub.jobs.upsert(9001, { name: "Sample", address: "123 Main St, Denver, CO 80211", customer: { name: "Jamie Sample", email: "", phone: "", company: "", attention: "" } });
  t.hub.jobs.upsert(9002, { name: "Example", address: "45 Pine Ave, Boulder, CO 80302", customer: { name: "Sam Example", email: "", phone: "", company: "", attention: "" } });
  const rec = (name: string, at: Date) => {
    const f = path.join(dir, name);
    writeFileSync(f, Buffer.alloc(40_000, 1));
    utimesSync(f, at, at);
    return f;
  };
  return { ...t, dir, rec };
}

describe("walk recordings", () => {
  it("reads the time from Samsung's file names, else the file's own time", () => {
    const m = new Date(2026, 10, 10, 15, 0, 0);
    expect(recordedAt("Voice 261110_143005.m4a", m)).toEqual(new Date(2026, 10, 10, 14, 30, 5));
    expect(recordedAt("Voice 001.m4a", m)).toEqual(m);
  });

  it("files a recording to the job on the calendar at that time, with notes the Estimator and timeline can use", async () => {
    const t = setup();
    // The mock calendar has "Scope walk #9001 Sample" at 9:00 today.
    const at = new Date(); at.setHours(9, 20, 0, 0);
    t.rec("Voice 001.m4a", at);
    const fresh = await scanWalks(t.hub, { now: new Date(at.getTime() + 3600e3), transcriber: async () => notes() });
    expect(fresh).toHaveLength(1);
    expect(fresh[0]).toMatchObject({ status: "filed", jobNumber: 9001, why: expect.stringContaining("calendar") });
    const md = readFileSync(path.join(t.hub.jobs.folder(9001), fresh[0].notesFile!), "utf8");
    expect(md).toContain("## By room\n- **Hall bath**: Ceiling drywall down approx 4x6");
    expect(md).toContain("- Send the estimate (by Friday)");
    expect(md).toContain("Customer: We'd like LVP in the hallway.");
    expect(existsSync(path.join(t.hub.jobs.folder(9001), fresh[0].notesFile!.replace(/\.md$/, ".m4a")))).toBe(true);
    expect(jobWalks(t.hub, 9001)[0].summary).toContain("customer wants LVP");
    expect((await timeline(t.hub, 9001)).find((i) => i.title === "Scope walk recording")?.body).toContain("LVP");
    // Not processed twice.
    expect(await scanWalks(t.hub, { now: new Date(at.getTime() + 7200e3), transcriber: async () => notes() })).toEqual([]);
  });

  it("uses the address said in the recording when the calendar doesn't settle it, and asks when nothing does", async () => {
    const t = setup();
    const night = new Date(); night.setHours(22, 0, 0, 0); night.setDate(night.getDate() - 2);
    expect(await matchWalk(t.hub, night, { transcript: "We're at 45 Pine Ave looking at the kitchen.", names: [] })).toMatchObject({ jobNumber: 9002 });
    expect(await matchWalk(t.hub, night, { transcript: "Talking with the homeowner.", names: ["Sam Example"] })).toMatchObject({ jobNumber: 9002 });
    t.rec("Voice 002.m4a", night);
    const [w] = await scanWalks(t.hub, { now: new Date(night.getTime() + 3600e3), transcriber: async () => notes({ transcript: "Just some notes about the kitchen." }) });
    expect(w.status).toBe("needs-job");
    const filed = fileWalk(t.hub, w.id, 9002);
    expect(filed).toMatchObject({ status: "filed", jobNumber: 9002 });
    expect(jobWalks(t.hub, 9002)).toHaveLength(1);
    expect(walks(t.hub).filter((x) => x.status !== "filed")).toEqual([]);
  });

  it("skips recordings from before it was set up, and ones still being written", async () => {
    const t = setup();
    t.hub.cfg.walks.since = new Date().toISOString();
    t.rec("old memo.m4a", new Date(Date.now() - 30 * 864e5));
    t.rec("recording now.m4a", new Date());
    expect(await scanWalks(t.hub, { transcriber: async () => notes() })).toEqual([]);
  });

  it("offers the Homebase note and tasks for what was promised, only with a yes", async () => {
    const t = setup();
    const at = new Date(); at.setHours(9, 20, 0, 0);
    t.rec("Voice 003.m4a", at);
    const [w] = await scanWalks(t.hub, { now: new Date(at.getTime() + 3600e3), transcriber: async () => notes() });
    await offerWalkFollowups(t.hub, w);
    expect(JSON.stringify(t.homebase.writes)).toContain("Scope walk");
    expect((await t.hub.tasks.tasks()).some((k) => k.title === "Send the estimate (said: Friday) #9001")).toBe(true);
  });

  it("sends the audio to Gemini and gets structured notes back", async () => {
    const t = setup();
    t.hub.cfg.ai = { provider: "gemini", geminiKey: "k", geminiModel: "m", geminiFastModel: "f" };
    t.hub.gemini = new MockGemini(() => JSON.stringify(notes()));
    const f = t.rec("Voice 004.m4a", new Date(Date.now() - 3600e3));
    const n = await transcribe(t.hub, f);
    expect(n.rooms[0].room).toBe("Hall bath");
    const g = t.hub.gemini as MockGemini;
    expect(g.uploads).toEqual([f]);
    expect(g.requests[0].contents[0].parts.some((p: any) => p.fileData?.mimeType === "audio/mp4")).toBe(true);
  });
});
