import { describe, expect, it } from "vitest";
import { shorten, summariesFor } from "../src/agent/mailSummary.js";
import { testHub } from "./helpers.js";

describe("one-line email summaries", () => {
  it("keeps a summary to one line of 10 words or fewer", () => {
    expect(shorten('"Adjuster wants hallway flooring photos showing cupping before approving the LVP."')).toBe("Adjuster wants hallway flooring photos showing cupping before approving the");
    expect(shorten("  Sent\nWegener the revised estimate. ")).toBe("Sent Wegener the revised estimate");
  });
  it("has nothing for threads it hasn't summarized", () => {
    const { hub } = testHub();
    expect(summariesFor(hub, [{ id: "t1", historyId: "5" }])).toEqual({});
  });
});
