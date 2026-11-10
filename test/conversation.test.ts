import { describe, expect, it } from "vitest";
import { buildMime, replyRefs } from "../src/connectors/gmail/mime.js";
import { MockTexts } from "../src/connectors/texts/index.js";
import { jobConversation, mailJobs, replyReferences, replySubject, stripQuoted } from "../src/workflows/conversation.js";
import { syncTexts } from "../src/workflows/texts.js";
import { testHub } from "./helpers.js";

describe("a job's conversation", () => {
  it("shows only the new part of an email, not the quoted history under it", () => {
    expect(stripQuoted("Sounds good, Thursday works.\n\nOn Mon, Nov 9, 2026 at 3:10 PM Hunter <h@x.com> wrote:\n> Can we walk it Thursday?\n> Thanks")).toBe("Sounds good, Thursday works.");
    expect(stripQuoted("Yes.\n\n-----Original Message-----\nFrom: Hunter\nold")).toBe("Yes.");
    expect(stripQuoted("See below.\n\nFrom: Hunter Patterson\nSent: Monday\nTo: Alex\n\nold text")).toBe("See below.");
    expect(stripQuoted("Just a normal email.\nTwo lines.")).toBe("Just a normal email.\nTwo lines.");
  });

  it("puts a job's emails and texts in one line, oldest first, and knows what a reply answers", async () => {
    const t = testHub();
    t.hub.jobs.upsert(9001, { name: "Sample", address: "123 Main St, Denver, CO 80211", adjuster: { name: "Alex Adjuster", email: "alex.adjuster@carrier.example", phone: "303-555-0111", company: "", attention: "" } });
    t.hub.jobs.upsert(9002, { name: "Example", address: "45 Pine Ave, Boulder, CO 80302", customer: { name: "Sam Example", email: "sam@example.com", phone: "", company: "", attention: "" } });
    t.hub.texts = new MockTexts([{ id: "1", handle: "3035550111", fromMe: true, at: new Date().toISOString(), text: "Sending those photos now" }]);
    await syncTexts(t.hub);
    const c = await jobConversation(t.hub, 9001);
    expect(c.items.map((x) => x.kind)).toEqual(["email", "text"]);
    expect(c.items[0]).toMatchObject({ fromMe: false, who: "Alex Adjuster", threadId: "mock-thread-1" });
    expect(c.items[1]).toMatchObject({ fromMe: true, who: "to Alex Adjuster", body: "Sending those photos now" });
    expect(c.replyTo?.threadId).toBe("mock-thread-1");
    // The other job's thread isn't mixed in.
    expect((await jobConversation(t.hub, 9002)).items.every((x) => x.threadId !== "mock-thread-1")).toBe(true);
    expect(mailJobs(t.hub).map((j) => j.jobNumber).sort()).toEqual([9001, 9002]);
  });
});

describe("replies stay in their thread", () => {
  it("builds References from the original's chain plus the original, each id once", () => {
    expect(replyReferences({ references: "<a@x> <b@x>", messageIdHeader: "<c@x>" })).toBe("<a@x> <b@x> <c@x>");
    expect(replyReferences({ messageIdHeader: "<c@x>" })).toBe("<c@x>");
    expect(replyRefs("<a@x> <c@x>", "<c@x>")).toBe("<a@x> <c@x>");
  });
  it("keeps one Re: on the thread's subject", () => {
    expect(replySubject("RE: Re: Sample – 123 Main St")).toBe("Re: Sample – 123 Main St");
    expect(replySubject("Your Reconstruction Estimate")).toBe("Re: Your Reconstruction Estimate");
  });
  it("writes In-Reply-To and the full References into the email", () => {
    const mime = buildMime({ from: "h@x.com", to: ["a@x.com"], bcc: [], subject: "Re: Sample", body: "Hi", attachments: [], messageId: "<new@x>", inReplyTo: "<c@x>", references: "<a@x> <b@x> <c@x>" });
    expect(mime).toContain("In-Reply-To: <c@x>\r\nReferences: <a@x> <b@x> <c@x>");
    expect(buildMime({ from: "h@x.com", to: ["a@x.com"], bcc: [], subject: "New", body: "Hi", attachments: [], messageId: "<n@x>" })).not.toContain("References:");
  });
});
