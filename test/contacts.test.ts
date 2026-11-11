import { describe, expect, it } from "vitest";
import { allContacts, findContacts, flushContacts, noteJobContacts, noteMessages, signaturePhones } from "../src/workflows/contacts.js";
import { testHub } from "./helpers.js";

const msg = (from: string, to: string[], body: string, cc: string[] = []) => ({ id: "m", from, to, cc, date: "2026-11-05T16:00:00Z", subject: "S", body, attachments: [] });

describe("contacts list", () => {
  it("logs everyone on an email, skipping Hunter, office+ boxes and no-reply senders", () => {
    const { hub } = testHub();
    noteMessages(hub, [msg("Alex Adjuster <alex.adjuster@carrier.example>", ["hunter@forefrontteam.com", "office+3226@forefrontteam.com"], "Hi\n\nAlex Adjuster\nCell: 303-555-0142", ["Doe, Jane <jane@example.com>"]), msg("QuickBooks <no-reply@intuit.com>", ["hunter@forefrontteam.com"], "Receipt")]);
    const all = allContacts(hub);
    expect(all.map((p) => p.name).sort()).toEqual(["Alex Adjuster", "Jane Doe"]);
    const alex = all.find((p) => p.name === "Alex Adjuster")!;
    expect(alex.phones).toEqual([{ number: "(303) 555-0142", label: "mobile", from: "email" }]);
    expect(alex.emailCount).toBe(1);
  });

  it("fills a person out from their jobs and Homebase, and finds them by job or company", async () => {
    const { hub } = testHub();
    noteMessages(hub, [msg("eileen <eileen@example.com>", ["hunter@forefrontteam.com"], "thanks")]);
    noteJobContacts(hub, 3226, "Augustine", [{ role: "customer", name: "Eileen Augustine", email: "Eileen@example.com", phone: "7195550101", id: "hb-1", company: "Augustine Household" }]);
    const [p] = await findContacts(hub, "#3226");
    expect(p).toMatchObject({ name: "Eileen Augustine", emails: ["eileen@example.com"], homebaseId: "hb-1", company: "Augustine Household", jobs: [{ jobNumber: 3226, name: "Augustine", role: "Customer" }] });
    expect((await findContacts(hub, "augustine household"))[0].name).toBe("Eileen Augustine");
    expect(await findContacts(hub, "555-0101")).toHaveLength(1);
    flushContacts(hub);
  });

  it("asks Homebase when looking someone up", async () => {
    const { hub } = testHub();
    const found = await findContacts(hub, "Alex", { homebase: true });
    expect(found.some((p) => p.emails.includes("alex.adjuster@carrier.example"))).toBe(true);
  });

  it("reads phone numbers out of a signature, not the quoted reply", () => {
    expect(signaturePhones("Thanks\n\nSam\nO: (720) 555-0199 | F: 720-555-0100\n\nOn Mon, Bob wrote:\n> call 303-555-9999").map((p) => p.number)).toEqual(["7205550199"]);
  });
});

describe("one person, one card", () => {
  const person = (id: string, o: Partial<import("../src/workflows/contacts.js").Person>) => ({ id, name: "", emails: [], phones: [], jobs: [], emailCount: 0, firstSeen: "2026-01-01T00:00:00Z", lastSeen: "2026-01-01T00:00:00Z", ...o });
  const store = (...list: ReturnType<typeof person>[]) => ({ people: Object.fromEntries(list.map((p) => [p.id, p])) });

  it("folds a texts-only entry into the same person from email, keeping everything from both", async () => {
    const { mergeDuplicates } = await import("../src/workflows/contacts.js");
    const s = store(
      person("heather@example.com", { name: "Heather Hanley", emails: ["heather@example.com"], emailCount: 4, company: "Westwind HOA" }),
      person("tel:7205550142", { name: "Heather", phones: [{ number: "(720) 555-0142", from: "you" }], jobs: [{ jobNumber: 6001, name: "Forbes", role: "Property manager" }] }),
      person("hh@example.org", { name: "Heather Hanley", emails: ["hh@example.org"], phones: [{ number: "720-555-0142", from: "email" }], emailCount: 1 }),
    );
    expect(mergeDuplicates(s)).toBe(2);
    expect(Object.values(s.people)).toHaveLength(1);
    expect(s.people["heather@example.com"]).toMatchObject({ name: "Heather Hanley", emails: ["heather@example.com", "hh@example.org"], emailCount: 5, company: "Westwind HOA", jobs: [{ jobNumber: 6001, role: "Property manager" }] });
    expect(s.people["heather@example.com"].phones).toHaveLength(1);
  });

  it("keeps different people apart: a shared office line, two Homebase records, a shared mailbox name", async () => {
    const { mergeDuplicates } = await import("../src/workflows/contacts.js");
    const s = store(
      person("a@example.com", { name: "Ana Ruiz", emails: ["a@example.com"], phones: [{ number: "(303) 555-0111", from: "email" }] }),
      person("b@example.com", { name: "Ben Cole", emails: ["b@example.com"], phones: [{ number: "(303) 555-0111", from: "email" }] }),
      person("hb:1", { name: "John Smith", homebaseId: "1" }),
      person("hb:2", { name: "John Smith", homebaseId: "2" }),
      person("c1@example.com", { name: "Claims Team", emails: ["c1@example.com"] }),
      person("c2@example.net", { name: "Claims Team", emails: ["c2@example.net"] }),
    );
    expect(mergeDuplicates(s)).toBe(0);
    expect(Object.values(s.people)).toHaveLength(6);
  });
});
