import { describe, expect, it } from "vitest";
import { MockGemini } from "../src/connectors/gemini/index.js";
import { askAndApply, checkTasks, flaggedTasks, jobOfTask, reviewTasks } from "../src/workflows/taskCheck.js";
import { pullJob } from "../src/workflows/pull.js";
import { testHub } from "./helpers.js";

async function setup() {
  const t = testHub();
  await pullJob(t.hub, 9001);
  await pullJob(t.hub, 9002);
  // Clear the mock's own sample tasks, then add the ones each test needs.
  for (const x of await t.hub.tasks.tasks()) await t.hub.tasks.remove(x.listId, x.id);
  return t;
}

describe("checking Hunter's tasks against his jobs", () => {
  it("finds a task's job by its number or its name, and flags closed jobs and duplicates", async () => {
    const { hub } = await setup();
    hub.jobs.upsert(9002, { stage: "Closed Lost" });
    const a = await hub.tasks.create({ title: "Sample - send the hallway photos", notes: "Job #9001" });
    const b = await hub.tasks.create({ title: "Sample - send the hallway photos" });
    const c = await hub.tasks.create({ title: "Example - follow up on the proposal" });
    const jobs = hub.jobs.list();
    expect(jobOfTask(a, jobs)?.jobNumber).toBe(9001);
    expect(jobOfTask(c, jobs)?.jobNumber).toBe(9002);
    const r = await checkTasks(hub);
    expect(r.changes.map((x) => [x.title, x.verdict])).toEqual([["Example - follow up on the proposal", "outdated"], ["Sample - send the hallway photos", "duplicate"]]);
    expect(r.changes.find((x) => x.verdict === "duplicate")?.taskId).toBe(b.id); // the newer copy goes
    expect(flaggedTasks.has(c.id)).toBe(true); // the brief leaves it out until answered
  });

  it("asks the AI about the rest with each job's facts, and keeps anything it isn't sure about", async () => {
    const t = await setup();
    t.hub.jobs.upsert(9001, { stage: "Work In Progress" });
    t.hub.jobs.upsert(9002, { stage: "Proposal Submitted", sendoff: { ...t.hub.jobs.get(9002).sendoff, sentAt: "2026-11-20T16:00:00Z" } });
    await t.hub.tasks.create({ title: "Sample - order the cabinets" });
    await t.hub.tasks.create({ title: "Example - send the estimate" });
    await t.hub.tasks.create({ title: "Example - call about selections" });
    await t.hub.tasks.create({ title: "Sampel - check on vanity", notes: "Job #9001" });
    t.hub.cfg.ai = { provider: "gemini", geminiKey: "k", geminiModel: "main", geminiFastModel: "fast" };
    let prompt = "";
    t.hub.gemini = new MockGemini((req) => {
      prompt = JSON.stringify(req.contents);
      return JSON.stringify({ tasks: [
        { tag: "T1", verdict: "not_mine", why: "Sample is in Work In Progress: ordering is the PM's" },
        { tag: "T2", verdict: "done", why: "the estimate was sent on Nov 20" },
        { tag: "T3", verdict: "keep", why: "still open" },
        { tag: "T4", verdict: "fix", why: "the job's name is misspelled", newTitle: "Sample - check on vanity" },
      ] });
    });
    const r = await checkTasks(t.hub);
    expect(prompt).toContain("stage Work In Progress");
    expect(prompt).toContain("the project manager's now");
    expect(prompt).toContain("estimate sent 2026-11-20");
    expect(r.changes.map((x) => x.verdict)).toEqual(["not_mine", "done", "fix"]);
    // On Yes: ticked off with the reason (never deleted), and the misspelled one renamed.
    const n = await askAndApply(t.hub, r.changes, { asked: true });
    expect(n).toBe(3);
    const after = await t.hub.tasks.tasks({ showCompleted: true });
    expect(after.find((x) => x.title === "Sample - order the cabinets")).toMatchObject({ completed: true });
    expect(after.find((x) => x.title === "Sample - order the cabinets")?.notes).toMatch(/Closed by Keystone .*not yours.*ordering is the PM's/);
    expect(after.find((x) => x.title === "Sample - check on vanity")).toMatchObject({ completed: false });
    expect(after.find((x) => x.title === "Example - call about selections")).toMatchObject({ completed: false });
  });

  it("changes nothing on No, and doesn't ask about those tasks again until they change", async () => {
    const t = testHub(false);
    await pullJob(t.hub, 9002);
    for (const x of await t.hub.tasks.tasks()) await t.hub.tasks.remove(x.listId, x.id);
    t.hub.jobs.upsert(9002, { stage: "Closed Lost" });
    await t.hub.tasks.create({ title: "Example - follow up on the proposal" });
    const r = await reviewTasks(t.hub, { asked: true });
    expect([r.changes.length, r.changed]).toEqual([1, 0]);
    expect((await t.hub.tasks.tasks()).every((x) => !x.completed)).toBe(true);
    expect((await checkTasks(t.hub)).changes).toEqual([]);
  });

  it("leaves out tasks a typed answer keeps", async () => {
    const t = await setup();
    t.hub.jobs.upsert(9001, { stage: "Closed Lost" });
    t.hub.jobs.upsert(9002, { stage: "Closed Lost" });
    await t.hub.tasks.create({ title: "Sample - pick up the check" });
    await t.hub.tasks.create({ title: "Example - return the key" });
    t.hub.approver.confirmOrReply = async () => ({ yes: false, reply: "keep Example" });
    const r = await reviewTasks(t.hub, { asked: true });
    expect(r.changed).toBe(1);
    const left = (await t.hub.tasks.tasks()).filter((x) => !x.completed).map((x) => x.title);
    expect(left).toEqual(["Example - return the key"]);
  });
});
