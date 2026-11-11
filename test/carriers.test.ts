import { describe, expect, it } from "vitest";
import { applyCarrierRule, carrierRules, isToInsurance, ruleForJob } from "../src/workflows/carriers.js";
import { createGeneratedDraft } from "../src/workflows/generated.js";
import { testHub } from "./helpers.js";

const SF = "statefarmfireclaims@statefarm.com";
function setup() {
  const t = testHub();
  t.hub.cfg.hubRoot = process.cwd(); // the real config/carriers.json
  const j = t.hub.jobs.upsert(7201, { name: "Young", address: "6924 Sierra Meadows Drive, Colorado Springs, CO", carrier: "State Farm Insurance Claims", claimNumber: "060V2R840", adjuster: { name: "Dana Desk", email: "dana.desk@statefarm.com", phone: "", company: "", attention: "" } });
  t.hub.jobs.upsert(7202, { name: "Other", address: "1 Elm St", carrier: "Acme Mutual", claimNumber: "A-1", adjuster: { name: "Pat", email: "pat@acme.example", phone: "", company: "", attention: "" } });
  return { ...t, j };
}

describe("carrier email rules", () => {
  it("knows State Farm from the carrier's name in Homebase, and leaves other carriers alone", () => {
    const t = setup();
    expect(carrierRules(t.hub).map((r) => r.carrier)).toContain("State Farm");
    expect(ruleForJob(t.hub, t.j)?.to).toBe(SF);
    expect(ruleForJob(t.hub, t.hub.jobs.get(7202))).toBeNull();
  });

  it("sends to the claims inbox with only the claim number as the subject; a named adjuster moves to Cc", () => {
    const t = setup();
    const rule = ruleForJob(t.hub, t.j)!;
    const d = applyCarrierRule(rule, t.j, { to: ["dana.desk@statefarm.com"], cc: [], subject: "Young – 6924 Sierra Meadows Drive – Repair Estimate – Claim 060V2R840" });
    expect(d).toMatchObject({ to: [SF], cc: ["dana.desk@statefarm.com"], subject: "060V2R840" });
    expect(isToInsurance(rule, t.j, ["someone@statefarm.com"])).toBe(true);
    expect(isToInsurance(rule, t.j, ["ed@young.example"])).toBe(false);
    expect(applyCarrierRule(rule, { claimNumber: "" }, { to: [SF], subject: "Estimate" })).toMatchObject({ subject: "Estimate", missing: expect.stringContaining("claim number") });
  });

  it("is applied to every new AI draft to insurance, but not to the homeowner's email or a reply in a thread", async () => {
    const t = setup();
    await createGeneratedDraft(t.hub, { to: ["dana.desk@statefarm.com"], bcc: [], subject: "Repair estimate for Ed Young", body: "Hello,\n\nAttached.\n\nThanks,", attachments: [] }, { jobNumber: 7201 });
    await createGeneratedDraft(t.hub, { to: ["ed@young.example"], bcc: [], subject: "Your Reconstruction Estimate – 6924 Sierra Meadows Drive", body: "Hi Ed,\n\nAttached.\n\nThanks,", attachments: [] }, { jobNumber: 7201 });
    await createGeneratedDraft(t.hub, { to: ["dana.desk@statefarm.com"], bcc: [], subject: "Re: Photos", body: "Hi Dana,\n\nHere they are.\n\nThanks,", attachments: [], threadId: "t-1" }, { jobNumber: 7201 });
    const drafts = (t.gmail as any).load().map((d: any) => ({ to: d.input.to, cc: d.input.cc, subject: d.input.subject }));
    expect(drafts[0]).toMatchObject({ to: [SF], cc: ["dana.desk@statefarm.com"], subject: "060V2R840" });
    expect(drafts[1]).toMatchObject({ to: ["ed@young.example"], subject: "Your Reconstruction Estimate – 6924 Sierra Meadows Drive" });
    expect(drafts[2]).toMatchObject({ to: ["dana.desk@statefarm.com"], subject: "Re: Photos" });
  });
});
