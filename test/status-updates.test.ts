import { describe, expect, it } from "vitest";
import { MockGemini } from "../src/connectors/gemini/index.js";
import { FixedApprover } from "../src/core/approval.js";
import { EventBus, WebApprover } from "../src/server/events.js";
import { applyReply, docLines, fieldMap, findUpdateField, setStatusUpdate, updateProposalJobs } from "../src/workflows/statusUpdates.js";
import { timeline } from "../src/workflows/timeline.js";
import { testHub } from "./helpers.js";

async function setup(answer = true) {
  const t = testHub(answer);
  t.hub.cfg.ai = { provider: "gemini", geminiKey: "k", geminiModel: "main", geminiFastModel: "fast" };
  t.hub.cfg.homebase.me = ""; // the fixture jobs have no people on them
  await t.hub.homebase.updateFields!(9002, { proposalSubmittedUpdate: "" });
  await t.hub.homebase.addNote(9002, { kind: "note", body: "Adjuster agreed to O&P and the door R&R; carpet still open." });
  let asked = 0;
  t.hub.gemini = new MockGemini(() => { asked++; return JSON.stringify({ update: "11/18: Adjuster agreed to O&P and door R&R; waiting on carpet.", nothingNew: false }); });
  return { ...t, asked: () => asked };
}

describe("the Proposal Submitted status line in Homebase", () => {
  it("finds the update field by name, or lists what might be it", () => {
    expect(findUpdateField({ money: { proposalAmount: 1, proposalSubmittedOn: "2026-11-01" }, brief: { proposalSubmittedUpdate: "11/10: sent" } })).toEqual({ key: "proposalSubmittedUpdate", current: "11/10: sent" });
    expect(findUpdateField({ statusUpdate: null, updatedAt: "x" })).toEqual({ key: "statusUpdate", current: "" });
    expect(findUpdateField({ stageUpdate: "a", proposalUpdate: "b" })).toMatchObject({ key: "proposalUpdate" });
    const none = findUpdateField({ customerNotes: "x", brief: { stageNotes: [] } });
    expect(none).toHaveProperty("candidates");
    expect((none as { candidates: string[] }).candidates.join(" ")).toContain("brief.stageNotes (list)");
    expect(findUpdateField({ brief: { weird: "z" } }, "weird")).toEqual({ key: "weird", current: "z" });
    // Homebase's own name for it wins over a plain "update" field, and the old text is what gets replaced.
    expect(findUpdateField({ statusUpdate: "x", brief: { proposalSubmittedNotes: "11/10: sent to adjuster" } })).toEqual({ key: "proposalSubmittedNotes", current: "11/10: sent to adjuster" });
    expect(findUpdateField({ proposalNotes: null })).toEqual({ key: "proposalNotes", current: "" });
  });

  it("writes every job's new line after one OK, and doesn't rewrite when nothing new happened", async () => {
    const { hub, asked } = await setup();
    expect((await timeline(hub, 9002)).length).toBeGreaterThan(0);
    const r = await updateProposalJobs(hub);
    expect(r.written).toBe(1);
    expect((await hub.homebase.rawJob!(9002)).proposalSubmittedUpdate).toBe("11/18: Adjuster agreed to O&P and door R&R; waiting on carpet.");
    const card = (hub.approver as FixedApprover).asked.at(-1)!;
    expect(card.action).toMatch(/Replace the Proposal Submitted Notes on 1 Homebase job/);
    expect(card.details[0]).toMatch(/^#9002 Example: 11\/18/);
    const before = asked();
    expect((await updateProposalJobs(hub)).written).toBe(0); // nothing new since
    expect(asked()).toBe(before);
  });

  it("writes nothing when Hunter says no, and takes his typed changes when he types them", async () => {
    const no = await setup(false);
    expect((await updateProposalJobs(no.hub)).written).toBe(0);
    expect((await no.hub.homebase.rawJob!(9002)).proposalSubmittedUpdate).toBe("");
    const typed = await setup(true);
    (typed.hub.approver as FixedApprover).reply = "Example: waiting on Liberty Mutual's carpet pricing";
    expect((await updateProposalJobs(typed.hub)).written).toBe(1);
    expect((await typed.hub.homebase.rawJob!(9002)).proposalSubmittedUpdate).toMatch(/^\d{1,2}\/\d{1,2}: waiting on Liberty Mutual's carpet pricing$/);
  });

  it("reads typed changes by job name or number, and skips", () => {
    const plan = [{ n: 3234, name: "Williams", text: "a" }, { n: 3226, name: "Augustine", text: "b" }];
    const r = applyReply(plan, "williams: 11/18: revised estimate sent\nskip #3226");
    expect(r).toEqual({ matched: 2, plan: [{ n: 3234, name: "Williams", text: "11/18: revised estimate sent" }] });
    expect(applyReply(plan, "sounds good").matched).toBe(0);
  });

  it("sets one job's line on request, dated, after asking", async () => {
    const { hub } = await setup();
    expect(await setStatusUpdate(hub, 9002, "Signed agreement expected Friday")).toMatch(/Saved on Homebase #9002: \d{1,2}\/\d{1,2}: Signed agreement expected Friday/);
  });
});

describe("when Homebase doesn't hand over a notes field", () => {
  it("saves a help file with field names only and the API reference's matching lines", async () => {
    const { hub } = await setup();
    hub.homebase.rawJob = async () => ({ id: "abc-123", jobNumber: "9002", brief: { customerNotes: "Dana prefers texts", productionNotes: null }, stages: [{ name: "Proposal Submitted", note: "secret" }] });
    hub.homebase.apiDocs = async () => "## Projects\nGET /projects/:id\n### Stage notes\nPATCH /projects/:id/stage-notes {stage, note}: the dashboard's per-stage notes\nunrelated line\nmore\nmore";
    const { MockDrive } = await import("../src/connectors/drive/index.js");
    const { mkdirSync, existsSync } = await import("node:fs");
    const droot = `${hub.cfg.stateDir}/drive`;
    hub.drive = new MockDrive(droot); mkdirSync(`${droot}/Keystone hand-off`, { recursive: true });
    hub.homebase.peek = async (p: string) => p.endsWith("/stage-notes") ? { status: 200, json: { notes: [{ id: "n1", stage: "Proposal Submitted", body: "secret text", pinned: false }] } } : { status: 404, json: null };
    const r = await updateProposalJobs(hub);
    expect(r.written).toBe(0);
    expect(r.problem).toMatch(/didn't hand Keystone a Proposal Submitted Notes field on job #9002.*homebase-notes-help\.txt.*Drive/);
    expect(existsSync(`${droot}/Keystone hand-off/_keystone/homebase-notes-help.txt`)).toBe(true);
    const { readFileSync } = await import("node:fs");
    const help = readFileSync(`${hub.cfg.stateDir}/homebase-notes-help.txt`, "utf8");
    expect(help).toContain("brief.customerNotes: string");
    expect(help).toContain("stages[].note: string");
    expect(help).toContain("PATCH /projects/:id/stage-notes");
    expect(help).toMatch(/GET \/projects\/:id\/stage-notes -> 200\n\s+notes: list of 1\n\s+notes\[\]\.id: string\n\s+notes\[\]\.stage: string = "Proposal Submitted"/);
    expect(help).toContain("GET /projects/:id/notes -> 404");
    expect(help).not.toContain("Dana"); expect(help).not.toContain("secret");
  });

  it("maps fields by kind and picks the reference's lines about notes", () => {
    expect(fieldMap({ a: 1, b: { c: null, d: ["x"] }, e: [{ f: true }] })).toEqual(["a: number", "b.c: empty", "b.d: list of 1", "e: list of 1", "e[].f: boolean"]);
    expect(docLines("one\ntwo\nproposalSubmittedNotes: string\nfour\nfive\nsix")).toEqual(["two", "proposalSubmittedNotes: string", "four", "five"]);
    expect(docLines('{"paths":{"/projects/{id}/notes":{}}}').join(" ")).toContain("/projects/{id}/notes");
  });
});

describe("Keystone's question cards", () => {
  it("lets Hunter type an answer instead of Yes or No", async () => {
    const bus = new EventBus();
    const seen: any[] = [];
    const emit = bus.emit.bind(bus);
    bus.emit = (e: any) => { if (e.type === "approval") seen.push(e); emit(e); };
    const a = new WebApprover(bus);
    const plain = a.confirm("Change the stage?", ["Lead -> Estimating"]);
    await new Promise((r) => setTimeout(r, 0));
    expect(seen[0]).toMatchObject({ action: "Change the stage?", replyAware: false });
    a.answer(seen[0].id, false, undefined, "Move it to Scope Walk instead");
    expect(await plain).toBe(false); // a typed answer is never a yes; the page hands it to the AI
    const aware = a.confirmOrReply("Update 2 jobs?", []);
    await new Promise((r) => setTimeout(r, 0));
    expect(seen[1].replyAware).toBe(true);
    a.answer(seen[1].id, false, undefined, "Williams: waiting on carpet");
    expect(await aware).toEqual({ yes: false, reply: "Williams: waiting on carpet" });
  });
});
