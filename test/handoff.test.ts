import { writeFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { handoffPrompt } from "../src/workflows/claudeHandoff.js";
import { testHub } from "./helpers.js";

describe("estimates in the Claude app", () => {
  it("writes the request with the job's details and the files to attach", () => {
    const { hub } = testHub();
    hub.jobs.upsert(3226, { name: "Augustine", address: "1071 Acapulco Ct, Colorado Springs, CO 80910", stage: "Estimating", carrier: "Farmers", claimNumber: "5045106171-1", customer: { name: "Jeremy Augustine", email: "j@example.com", phone: "" }, adjuster: { name: "Eileen Brandt", email: "eileen@claims.example", phone: "" }, companycamProjectId: "117697136", market: "CODE8X" });
    writeFileSync(hub.jobs.path(3226, "sketch", "Augustine.ESX"), "x");
    const { prompt, attach } = handoffPrompt(hub, 3226, "estimate");
    expect(prompt.startsWith("Use the forefront-estimate skill.")).toBe(true);
    for (const s of ["Job #3226 Augustine, 1071 Acapulco Ct", "Farmers, claim 5045106171-1", "Adjuster: Eileen Brandt", "CompanyCam project: 117697136", "Price list market: CODE8X", "Attached: Augustine.ESX", "Ask me the skill's questions"]) expect(prompt).toContain(s);
    expect(attach).toEqual(["sketch/Augustine.ESX"]);
    expect(handoffPrompt(hub, 3226, "revise", "Make the hallway LVP.").prompt).toContain("The change: Make the hallway LVP.");
  });
});
