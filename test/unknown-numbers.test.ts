import { describe, expect, it } from "vitest";
import { MockTexts } from "../src/connectors/texts/index.js";
import { allContacts } from "../src/workflows/contacts.js";
import { jobTexts } from "../src/workflows/texts.js";
import { nameFromTexts, nameNumber, skipNumber, unknownNumbers } from "../src/workflows/unknownNumbers.js";
import { testHub } from "./helpers.js";

const ago = (d: number) => new Date(Date.now() - d * 864e5).toISOString();
const setup = (texts: { handle: string; text: string; fromMe: boolean; daysAgo: number }[]) => {
  const t = testHub();
  t.hub.jobs.upsert(6001, { name: "Forbes", address: "412 Maple St, Denver, CO", stage: "Proposal Submitted", stageSince: ago(20), customer: { name: "Dana Forbes", email: "", phone: "(303) 555-0100", company: "", attention: "" } });
  t.hub.texts = new MockTexts(texts.map((x, i) => ({ id: String(i), handle: x.handle, fromMe: x.fromMe, at: ago(x.daysAgo), text: x.text })));
  return t.hub;
};
// Made-up people and numbers.
const HEATHER = "+17205550142";
const convo = [
  { handle: HEATHER, text: "Hi Hunter, this is Heather Hanley with the HOA. Can you send the estimate for 412 Maple St?", fromMe: false, daysAgo: 6 },
  { handle: HEATHER, text: "Hi Heather, the adjuster approved the drywall. Estimate is coming today.", fromMe: true, daysAgo: 5 },
  { handle: HEATHER, text: "Great, thanks!", fromMe: false, daysAgo: 2 },
];

describe("a name from how the texts read", () => {
  it("finds an introduction, a sign-off, or how you greeted them", () => {
    expect(nameFromTexts([{ fromMe: false, text: "Hey, this is Heather Hanley from the HOA" }])?.name).toBe("Heather Hanley");
    expect(nameFromTexts([{ fromMe: true, text: "Hi Marco, running 10 late" }])?.name).toBe("Marco");
    expect(nameFromTexts([{ fromMe: false, text: "The tile is in.\n- Priya" }])?.name).toBe("Priya");
    expect(nameFromTexts([{ fromMe: false, text: "I'm Running late, sorry" }, { fromMe: false, text: "ok" }])).toBeNull();
  });
});

describe("unknown numbers that look like work", () => {
  it("lists a work conversation with a suggested name and job, and leaves personal and known numbers out", async () => {
    const hub = setup([...convo, { handle: "+13035550177", text: "dinner at 6? this is Sam", fromMe: false, daysAgo: 1 }, { handle: "+13035550100", text: "Thanks for the estimate", fromMe: false, daysAgo: 1 }]);
    const r = await unknownNumbers(hub);
    expect(r.items.map((u) => u.key)).toEqual(["7205550142"]);
    expect(r.items[0]).toMatchObject({ phone: "(720) 555-0142", texts: 3, suggestedName: "Heather Hanley", suggestedJob: 6001 });
    expect(JSON.stringify(r)).not.toContain("dinner");
  });

  it("naming one ties the number to the job, so the whole conversation files there", async () => {
    const hub = setup(convo);
    expect(jobTexts(hub, 6001)).toHaveLength(0);
    const r = await nameNumber(hub, { key: "7205550142", name: "Heather Hanley", jobNumber: 6001, role: "Property manager" });
    expect(r.name).toBe("Heather Hanley");
    expect(jobTexts(hub, 6001)).toHaveLength(3);
    expect(allContacts(hub).find((p) => p.name === "Heather Hanley")).toMatchObject({ jobs: [{ jobNumber: 6001, role: "Property manager" }] });
    expect((await unknownNumbers(hub)).items).toHaveLength(0);
  });

  it("a skipped number, or one named without a job, stays off the list", async () => {
    const hub = setup(convo);
    skipNumber(hub, "7205550142");
    expect(await unknownNumbers(hub)).toMatchObject({ items: [], skipped: 1 });
    skipNumber(hub, "7205550142", true);
    expect((await unknownNumbers(hub)).items).toHaveLength(1);
    await nameNumber(hub, { key: "7205550142", name: "Heather Hanley" });
    expect((await unknownNumbers(hub)).items).toHaveLength(0);
    expect(jobTexts(hub, 6001)).toHaveLength(0);
  });

  it("says so when texts aren't connected", async () => {
    const hub = testHub().hub;
    expect(await unknownNumbers(hub)).toMatchObject({ connected: false, items: [] });
  });
});
