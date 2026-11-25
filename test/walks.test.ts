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
    expect((await t.hub.tasks.tasks()).some((k) => k.title === "Sample - send the estimate (said: Friday)")).toBe(true);
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
    expect(g.requests[0].stream).toBe(true); // the words first, streamed
    expect(g.requests[1].jsonSchema).toBeTruthy(); // then the notes from the words
  });

  it("matches a calendar visit that names the job (\"Sanders walk\"), lists the folder with reasons, and can move a recording", async () => {
    const { refileWalk, walkFolder, walkNotesText } = await import("../src/workflows/walks.js");
    const t = setup();
    t.hub.jobs.upsert(7001, { name: "Sanders", address: "8 Birch Rd, Golden, CO", customer: { name: "Lee Sanders", email: "", phone: "", company: "", attention: "" } });
    const at = new Date(); at.setHours(13, 10, 0, 0); at.setDate(at.getDate() - 1);
    await t.hub.calendar.create({ title: "Sanders walk", start: new Date(at.getTime() - 10 * 60e3).toISOString(), end: new Date(at.getTime() + 50 * 60e3).toISOString() });
    expect(await matchWalk(t.hub, at, { transcript: "kitchen notes", names: [] })).toMatchObject({ jobNumber: 7001, why: "calendar: Sanders walk" });
    t.hub.cfg.walks.since = new Date().toISOString();
    t.rec("Voice 010.m4a", at);
    expect(walkFolder(t.hub)[0]).toMatchObject({ name: "Voice 010.m4a", waiting: expect.stringMatching(/before walk recordings were connected/) });
    const [w] = await scanWalks(t.hub, { only: "Voice 010.m4a", transcriber: async () => notes() });
    expect(w).toMatchObject({ status: "filed", jobNumber: 7001 });
    expect(walkNotesText(t.hub, w.id)).toContain("## Transcript");
    const moved = refileWalk(t.hub, w.id, 9002);
    expect(moved.jobNumber).toBe(9002);
    expect(jobWalks(t.hub, 7001)).toEqual([]);
    expect(jobWalks(t.hub, 9002)).toHaveLength(1);
  });
});

describe("only the walk is kept", () => {
  it("takes out the stretches the transcriber marked as not the walk, and lists what they were", async () => {
    const { splitLeftOut, walkMarkdown } = await import("../src/workflows/walks.js");
    const r = splitLeftOut("Hunter: Hall bath, vanity is swollen.\nCustomer: We want the same tile.\n[Left out: audiobook playing while driving, about 25 minutes]\n[Left out: phone call not about this job, about 6 minutes]");
    expect(r.transcript).toBe("Hunter: Hall bath, vanity is swollen.\nCustomer: We want the same tile.");
    expect(r.leftOut).toEqual(["audiobook playing while driving, about 25 minutes", "phone call not about this job, about 6 minutes"]);
    const md = walkMarkdown({ recordedAt: new Date().toISOString(), name: "Voice 1.m4a" }, { transcript: r.transcript, leftOut: r.leftOut, summary: "s", rooms: [], measurements: [], customerWants: [], promises: [] });
    expect(md).toContain("## Left out (not part of the walk)\n- audiobook playing while driving, about 25 minutes");
  });

  it("tells Gemini to transcribe only the walk, and a recording can be done over without losing its job", async () => {
    const t = setup();
    t.hub.cfg.ai = { provider: "gemini", geminiKey: "k", geminiModel: "m", geminiFastModel: "f" };
    t.hub.gemini = new MockGemini(() => JSON.stringify(notes()));
    const f = t.rec("Voice 020.m4a", new Date(Date.now() - 3600e3));
    await transcribe(t.hub, f);
    expect(JSON.stringify((t.hub.gemini as MockGemini).requests[0])).toMatch(/audiobook, podcast, radio/);
    const [first] = await scanWalks(t.hub, { only: "Voice 020.m4a", transcriber: async () => notes() });
    const [again] = await scanWalks(t.hub, { only: "Voice 020.m4a", redo: true, transcriber: async () => notes({ summary: "Done over." }) });
    expect(again).toMatchObject({ id: first.id, summary: "Done over.", jobNumber: first.jobNumber });
    expect(walks(t.hub).filter((w) => w.id === first.id)).toHaveLength(1);
  });
});

describe("after the initial scope walk", () => {
  it("offers to move a job from Lead or Scope Walk to Estimating, and leaves later stages alone", async () => {
    const { offerEstimatingStage } = await import("../src/workflows/walks.js");
    const t = setup();
    const at = new Date(); at.setHours(9, 20, 0, 0);
    t.rec("Voice 030.m4a", at);
    const [w] = await scanWalks(t.hub, { now: new Date(at.getTime() + 3600e3), transcriber: async () => notes() });
    const n = w.jobNumber!;
    const stage = async (s: string) => { (t.homebase as any).writes.length = 0; await t.hub.homebase.setStage(n, s); (t.homebase as any).writes.length = 0; };
    const moved = () => (t.homebase.writes as any[]).filter((x) => x.op === "setStage").map((x) => x.args?.stage ?? x.data?.stage ?? x.stage);
    await stage("Lead");
    expect(await offerEstimatingStage(t.hub, w)).toBe(true);
    expect(JSON.stringify(t.homebase.writes)).toContain("Estimating");
    expect(t.hub.jobs.get(n).stage).toBe("Estimating");
    expect((await t.hub.homebase.getJob(n)).stage).toBe("Estimating");
    await stage("Scope Walk");
    expect(await offerEstimatingStage(t.hub, w)).toBe(true);
    for (const later of ["Estimating", "Proposal Submitted", "Work In Progress"]) {
      await stage(later);
      expect(await offerEstimatingStage(t.hub, w)).toBe(false);
      expect(moved()).toEqual([]);
    }
  });

  it("changes nothing when the answer is no", async () => {
    const { offerEstimatingStage } = await import("../src/workflows/walks.js");
    const { FixedApprover } = await import("../src/core/approval.js");
    const t = setup();
    t.hub.approver = new FixedApprover(false);
    const at = new Date(); at.setHours(9, 20, 0, 0);
    t.rec("Voice 031.m4a", at);
    const [w] = await scanWalks(t.hub, { now: new Date(at.getTime() + 3600e3), transcriber: async () => notes() });
    await t.hub.homebase.setStage(w.jobNumber!, "Lead");
    expect(await offerEstimatingStage(t.hub, w)).toBe(false);
    expect((await t.hub.homebase.getJob(w.jobNumber!)).stage).toBe("Lead");
  });
});

describe("cutting and removing recordings", () => {
  it("reads where each left-out stretch is", async () => {
    const { splitLeftOut } = await import("../src/workflows/walks.js");
    const r = splitLeftOut("Hunter: Kitchen floor is cupped.\n[Left out 12:30-18:45: phone call not about this job, about 6 minutes]\n[Left out 1:02:00-1:10:30: radio while driving]\nHunter: Done.");
    expect(r.leftOut).toEqual(["phone call not about this job, about 6 minutes", "radio while driving"]);
    expect(r.cuts).toEqual([[750, 1125], [3720, 4230]]);
    expect(r.transcript).toBe("Hunter: Kitchen floor is cupped.\nHunter: Done.");
  });

  it("builds a filter that cuts the marked stretches and long silences", async () => {
    const { trimFilter } = await import("../src/workflows/walks.js");
    expect(trimFilter([[750, 1125]])).toMatch(/^aselect='not\(between\(t,750,1125\)\)',asetpts=N\/SR\/TB,silenceremove=.*stop_duration=4/);
    expect(trimFilter()).toMatch(/^silenceremove=/);
  });

  it("removes a filed recording from its job and doesn't pick it up again", async () => {
    const t = setup();
    const at = new Date(); at.setHours(9, 20, 0, 0);
    t.rec("Voice 009.m4a", at);
    const [w] = await scanWalks(t.hub, { now: new Date(at.getTime() + 3600e3), transcriber: async () => notes() });
    expect(jobWalks(t.hub, 9001)).toHaveLength(1);
    const { removeWalk } = await import("../src/workflows/walks.js");
    removeWalk(t.hub, w.id);
    expect(jobWalks(t.hub, 9001)).toHaveLength(0);
    expect(existsSync(t.hub.jobs.path(9001, "notes", "walks"))).toBe(true);
    expect(walks(t.hub).find((x) => x.id === w.id)).toMatchObject({ summary: "(removed)" });
    expect(walks(t.hub).find((x) => x.id === w.id)?.jobNumber).toBeUndefined();
    expect(await scanWalks(t.hub, { now: new Date(at.getTime() + 7200e3), transcriber: async () => notes() })).toEqual([]);
    // One never transcribed can be removed by name, so it's never picked up.
    t.rec("Voice 010.m4a", at);
    removeWalk(t.hub, "Voice 010.m4a");
    expect(await scanWalks(t.hub, { now: new Date(at.getTime() + 7200e3), transcriber: async () => notes() })).toEqual([]);
  });

  it("cuts the job's copy down with ffmpeg and leaves the original alone", async () => {
    const { ffmpegPath, trimWalkAudio, removeWalk } = await import("../src/workflows/walks.js");
    const ff = ffmpegPath();
    if (!ff) return; // ffmpeg isn't on this computer
    const { spawnSync } = await import("node:child_process");
    const t = setup();
    const at = new Date(); at.setHours(9, 20, 0, 0);
    // 5 s of talking-level tone, 30 s of silence, 5 s of tone, 20 s that Gemini marked as a phone call.
    const f = path.join(t.dir, "Voice 020.m4a");
    const r = spawnSync(ff, ["-y", "-loglevel", "error", "-f", "lavfi", "-i", "sine=f=440:d=5", "-f", "lavfi", "-i", "anullsrc=r=44100:cl=mono:d=30", "-f", "lavfi", "-i", "sine=f=440:d=25",
      "-filter_complex", "[0][1][2]concat=n=3:v=0:a=1", "-c:a", "aac", f]);
    expect(r.status).toBe(0);
    utimesSync(f, at, at);
    const [w] = await scanWalks(t.hub, { now: new Date(at.getTime() + 3600e3), transcriber: async () => ({ ...notes(), cuts: [[40, 60]] }) });
    const said = trimWalkAudio(t.hub, w.id);
    expect(said).toMatch(/Trimmed the audio from 1 to 0 min \(1 stretch that weren't the walk and long silences cut\)/);
    const copy = t.hub.jobs.path(9001, "notes", "walks", w.notesFile!.split("/").pop()!.replace(/\.md$/, ".m4a"));
    const len = (file: string) => Number((spawnSync(ff, ["-hide_banner", "-i", file], { encoding: "utf8" }).stderr.match(/Duration: (\d+):(\d+):([\d.]+)/) ?? []).slice(1).reduce((a, x, i) => a + Number(x) * [3600, 60, 1][i], 0));
    expect(len(copy)).toBeGreaterThan(8);
    expect(len(copy)).toBeLessThan(20); // 60 s down to the tone and a short pause
    expect(len(f)).toBeGreaterThan(59); // the original is untouched
    removeWalk(t.hub, w.id);
    expect(existsSync(copy)).toBe(false);
  });
});
