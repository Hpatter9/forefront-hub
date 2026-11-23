import { describe, expect, it } from "vitest";
import { checkContractsSigned, handoffBody, parseSigning } from "../src/workflows/contractSigned.js";
import { pullJob } from "../src/workflows/pull.js";
import { testHub } from "./helpers.js";

const confirmation = (o: Partial<{ id: string; subject: string; to: string; name: string }> = {}) => ({
  id: o.id ?? "sig1", from: "Forefront <office@forefrontteam.com>", to: [o.to ?? "sam@example.com"], cc: ["hunter@forefrontteam.com"], date: "2026-11-20T16:00:00Z",
  subject: o.subject ?? "Your signed sample - reconstruction agreement — 123 Main St, Denver",
  body: `Signed and on file\n\n*Document:* Reconstruction agreement\n\n*Property:* 123 Main St, Denver\n\n*Signed by:* ${o.name ?? "Sam Example"}\n\n*Signed on:* Nov 20, 2026\nHello ${o.name ?? "Sam Example"},\n\nThank you.`,
  attachments: [{ id: "a", filename: "Reconstruction Agreement.pdf", mimeType: "application/pdf" }], labelIds: ["INBOX"],
});

/** The test mailbox, with these confirmations sitting in it. */
function withMail(hub: any, msgs: any[]) {
  const list = hub.gmail.listThreads.bind(hub.gmail), get = hub.gmail.getThread.bind(hub.gmail);
  hub.gmail.listThreads = async (o: any) => {
    const r = await list(o);
    return { threads: [...msgs.filter(() => /signed/i.test(o?.q ?? "")).map((m) => ({ id: m.id, subject: m.subject, from: m.from, to: m.to.join(", "), date: m.date, snippet: "", messageCount: 1 })), ...r.threads] };
  };
  hub.gmail.getThread = async (id: string) => { const m = msgs.find((x) => x.id === id); return m ? { id, messages: [m] } : get(id); };
}

describe("project hand-off when the homeowner signs", () => {
  it("drafts Hunter's hand-off email to the signer, with the project manager copied, once", async () => {
    const { hub } = testHub();
    await pullJob(hub, 9001);
    withMail(hub, [confirmation()]);
    const r = await checkContractsSigned(hub);
    expect(r.map((x) => x.result)).toEqual(["drafted"]);
    const d = (hub.gmail as any).drafts()[0].input;
    expect(d.subject).toBe("Project Handoff");
    expect(d.to).toEqual(["Sam Example <sam@example.com>"]);
    expect(d.cc).toEqual(["Shannon Hoag <shannon@forefrontteam.com>"]);
    expect(d.bcc).toEqual([`office+${r[0].jobNumber}@forefrontteam.com`]);
    expect(d.body).toBe(handoffBody("Sam", "Shannon"));
    expect(d.body).toContain("From here, Shannon will be your Project Manager and main point of contact.");
    // The same confirmation never makes a second draft.
    expect(await checkContractsSigned(hub)).toEqual([]);
    expect((hub.gmail as any).drafts()).toHaveLength(1);
  });

  it("doesn't draft again for someone who already has a hand-off, or for an updated agreement", async () => {
    const { hub } = testHub();
    await pullJob(hub, 9001);
    withMail(hub, [confirmation(), confirmation({ id: "sig2" }), confirmation({ id: "sig3", subject: "Your signed updated reconstruction agreement — 123 Main St, Denver", to: "other@example.com" })]);
    const r = await checkContractsSigned(hub);
    expect(r.map((x) => x.result)).toEqual(["drafted", "already"]);
    expect((hub.gmail as any).drafts()).toHaveLength(1);
  });

  it("reads the confirmation, and ignores mail that isn't one", () => {
    expect(parseSigning(confirmation() as any)).toMatchObject({ to: "sam@example.com", signedBy: "Sam Example", property: "123 Main St, Denver" });
    expect(parseSigning({ ...confirmation(), from: "someone@example.com" } as any)).toBeNull();
    expect(parseSigning({ ...confirmation(), subject: "Your signed photo release — 123 Main St" } as any)).toBeNull();
  });
});
