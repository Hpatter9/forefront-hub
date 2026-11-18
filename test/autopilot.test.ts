import { describe, expect, it } from "vitest";
import { MockGemini } from "../src/connectors/gemini/index.js";
import { autopilot, autopilotNote, AUTOPILOT_TOOLS } from "../src/workflows/autopilot.js";
import { generatedDrafts } from "../src/workflows/generated.js";
import type { Reminder } from "../src/workflows/reminders.js";
import { jobTaskTitle, newStyleTitle, reformatOpenTasks, withJobNote } from "../src/workflows/taskTitle.js";
import { testHub } from "./helpers.js";

const tomorrow = new Date(Date.now() + 864e5).toLocaleDateString("en-CA", { timeZone: "America/Denver" });
async function setup() {
  const t = testHub();
  for (const x of await t.hub.tasks.tasks({ showCompleted: true })) await t.hub.tasks.remove(x.listId, x.id); // start with no sample tasks
  t.hub.cfg.ai = { provider: "gemini", geminiKey: "k", geminiModel: "main", geminiFastModel: "fast" };
  t.hub.jobs.upsert(9001, { name: "Belvill", address: "123 Main St, Denver, CO 80211", customer: { name: "Dana Belvill", email: "dana@example.com", phone: "", company: "", attention: "" } });
  return t;
}
const reminder = (o: Partial<Reminder>): Reminder => ({ kind: "followup", jobNumber: 9001, name: "Belvill", stage: "Proposal Submitted", title: "Proposal out", detail: "", days: 4, step: "", ...o });

describe("tasks in Hunter's format", () => {
  it("puts the job's name first and the job number in the notes", () => {
    expect(jobTaskTitle("Belvill", "Check in on selections #9001")).toBe("Belvill - check in on selections");
    expect(jobTaskTitle("Belvill", "Update estimate and send to homeowners")).toBe("Belvill - update estimate and send to homeowners");
    expect(jobTaskTitle("Belvill", "Send Eileen the photos re #9001")).toBe("Belvill - send Eileen the photos");
    expect(jobTaskTitle("Belvill", "Belvill - check in on selections")).toBe("Belvill - check in on selections");
    expect(withJobNote("From Dana", 9001)).toBe("Job #9001\nFrom Dana");
    expect(withJobNote("Job #9001\nFrom Dana", 9001)).toBe("Job #9001\nFrom Dana");
  });

  it("renames open tasks still in the old style", async () => {
    const t = await setup();
    await t.hub.tasks.create({ title: "Call Dana re #9001", due: tomorrow });
    await t.hub.tasks.create({ title: "Order business cards", due: tomorrow });
    expect(newStyleTitle(t.hub, "Order business cards")).toBeNull();
    expect(await reformatOpenTasks(t.hub)).toBe(1);
    const titles = (await t.hub.tasks.tasks()).map((x) => x.title).sort();
    expect(titles).toEqual(["Belvill - call Dana", "Order business cards"]);
    expect((await t.hub.tasks.tasks()).find((x) => x.title.startsWith("Belvill"))!.jobNumber).toBe(9001);
  });
});

describe("Keystone handles what it can before the brief", () => {
  it("drafts follow-ups and email-only tasks with draft-only tools, closes those tasks, and leaves the rest", async () => {
    const t = await setup();
    await t.hub.tasks.create({ title: "Belvill - send Dana the selections link", due: tomorrow, notes: "Job #9001" });
    await t.hub.tasks.create({ title: "Belvill - measure the hallway", due: tomorrow, notes: "Job #9001" });
    let draftN = 0;
    t.hub.gemini = new MockGemini((req) => {
      const text = JSON.stringify(req.contents);
      if (req.jsonSchema) return JSON.stringify({ tasks: [{ tag: "T1", action: "email", why: "an email" }, { tag: "T2", action: "hunter", why: "a site visit" }] });
      // The drafting run: make one draft, then report.
      if (!text.includes("functionResponse")) return { calls: [{ name: "gmail_create_draft", args: { jobNumber: 9001, to: ["dana@example.com"], subject: `Draft ${++draftN}`, body: "Hi Dana,\n\nChecking in.\n\nThanks," } }] };
      return "DRAFTED: to Dana, checking in.";
    });
    const r = await autopilot(t.hub, [reminder({ kind: "followup" }), reminder({ kind: "estimate", title: "Estimating: write the estimate" })]);
    expect(r.ran).toBe(true);
    expect(r.handled.map((h) => h.what)).toEqual(["Drafted a follow-up for #9001 Belvill", 'Drafted "Belvill - send Dana the selections link" and closed the task']);
    expect(r.leftForHunter).toEqual([{ title: "Belvill - measure the hallway", why: "a site visit" }]);
    expect(generatedDrafts(t.hub)).toHaveLength(2);
    const open = (await t.hub.tasks.tasks()).filter((x) => !x.completed).map((x) => x.title);
    expect(open).toEqual(["Belvill - measure the hallway"]);
    const closed = (await t.hub.tasks.tasks({ showCompleted: true })).find((x) => x.title.includes("selections link"))!;
    expect(closed.notes).toMatch(/Handled by Keystone .*Gmail Drafts/);
    // Only reading and drafting tools were offered.
    const offered = (t.hub.gemini as MockGemini).requests.filter((q) => q.tools).flatMap((q) => q.tools!.map((x) => x.name));
    expect(new Set(offered)).toEqual(new Set(AUTOPILOT_TOOLS));
    expect(autopilotNote(r)).toMatch(/drafts waiting in Gmail .*: 2/);
    // Run again: nothing is drafted twice.
    const again = await autopilot(t.hub, [reminder({ kind: "followup" })]);
    expect(again.handled).toEqual([]);
    expect(generatedDrafts(t.hub)).toHaveLength(2);
  });

  it("never runs on Claude, so it can't spend API money", async () => {
    const t = await setup();
    t.hub.cfg.ai = { ...t.hub.cfg.ai, provider: "claude" };
    const r = await autopilot(t.hub, [reminder({ kind: "followup" })]);
    expect(r).toMatchObject({ ran: false, handled: [] });
    expect(r.note).toMatch(/never spends Claude API money/);
  });
});
