import { describe, expect, it } from "vitest";
import { jobLabels, streetAndUnit } from "../src/core/jobLabel.js";

describe("job labels", () => {
  it("shortens the street and finds the unit", () => {
    expect(streetAndUnit("5925 E Evans Ave, Denver, CO 80222")).toEqual({ street: "5925 E Evans", unit: "" });
    expect(streetAndUnit("5925 E Evans Ave, Unit 302, Denver, CO 80222")).toEqual({ street: "5925 E Evans", unit: "302" });
    expect(streetAndUnit("5925 E Evans Ave #114, Denver, CO")).toEqual({ street: "5925 E Evans", unit: "114" });
    expect(streetAndUnit("19 Foxtail Dr, Castle Rock, CO")).toEqual({ street: "19 Foxtail", unit: "" });
    expect(streetAndUnit("12 Broadway, Boulder, CO").street).toBe("12 Broadway");
    expect(streetAndUnit("400 Main St NW, Denver").street).toBe("400 Main");
  });

  it("leaves a one-job customer alone and labels PM and repeat customers by street", () => {
    const l = jobLabels([
      { jobNumber: 3212, name: "Gorrell", address: "1 Elm St, Denver, CO" },
      { jobNumber: 3300, name: "LCP Development", company: "LCP Development", address: "5925 E Evans Ave, Unit 302, Denver, CO" },
      { jobNumber: 3301, name: "LCP Development", company: "LCP Development LLC", address: "5925 E Evans Ave, Unit 114, Denver, CO" },
      { jobNumber: 3302, name: "LCP Development", company: "LCP Development", address: "880 S Colorado Blvd, Denver, CO" },
      { jobNumber: 3310, name: "Acme Property Mgmt", company: "Acme Property Mgmt", address: "7 Pine Ct, Aurora, CO" },
      { jobNumber: 3400, name: "McCandless", address: "19 Foxtail Dr, Castle Rock, CO" },
      { jobNumber: 3401, name: "McCandless", address: "220 Oak Ln, Castle Rock, CO" },
      { jobNumber: 3500, name: "Smith", address: "9 Ash Way, Denver, CO" },
      { jobNumber: 3501, name: "Smith", address: "9 Ash Way, Denver, CO" },
    ]);
    expect(l.get(3212)).toBe("Gorrell");
    expect(l.get(3300)).toBe("LCP Development: 5925 E Evans #302");
    expect(l.get(3301)).toBe("LCP Development: 5925 E Evans #114");
    expect(l.get(3302)).toBe("LCP Development: 880 S Colorado");
    expect(l.get(3310)).toBe("Acme Property Mgmt: 7 Pine");
    expect(l.get(3400)).toBe("McCandless: 19 Foxtail");
    expect(l.get(3401)).toBe("McCandless: 220 Oak");
    expect(l.get(3500)).toBe("Smith: 9 Ash (#3500)");
  });
});
