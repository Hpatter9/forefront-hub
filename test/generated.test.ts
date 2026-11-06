import { describe, expect, it } from "vitest";
import { createGeneratedDraft, GENERATED_LABEL, openGeneratedDrafts, withDraftSource } from "../src/workflows/generated.js";
import { testHub } from "./helpers.js";

describe("Claude drafts folder", () => {
  it("files hub-made drafts with where they came from, labelled for Gmail", async () => {
    const { hub } = testHub();
    const sent: any[] = [];
    const orig = hub.gmail.createDraft.bind(hub.gmail);
    hub.gmail.createDraft = async (d) => (sent.push(d), orig(d));
    await createGeneratedDraft(hub, { to: ["eileen@example.com"], bcc: [], subject: "Hallway photos", body: "Hi Eileen,\n\nAttached.", attachments: [] }, { jobNumber: 3226 });
    await withDraftSource("Plan my day", () => createGeneratedDraft(hub, { to: ["alex@carrier.example"], bcc: [], subject: "Follow-up", body: "Hi Alex", attachments: [] }));
    expect(sent[0].labels).toEqual([GENERATED_LABEL]);
    const open = await openGeneratedDrafts(hub);
    expect(open.map((g) => [g.subject, g.source, g.jobNumber])).toEqual([
      ["Follow-up", "Plan my day", undefined],
      ["Hallway photos", "Claude", 3226],
    ]);
  });

  it("drops a draft from the folder once it's sent", async () => {
    const { hub } = testHub();
    const ref = await createGeneratedDraft(hub, { to: ["a@b.example"], bcc: [], subject: "S", body: "B", attachments: [] });
    hub.gmail.draftStatus = async (r) => (r.id === ref.id ? { state: "sent", sentAt: new Date().toISOString() } : { state: "draft" });
    expect(await openGeneratedDrafts(hub)).toEqual([]);
  });
});

describe("drafts are never sent on their own", () => {
  it("Claude's tools can make drafts but have no way to send", async () => {
    const { readFileSync } = await import("node:fs");
    const tools = readFileSync(new URL("../src/agent/tools.ts", import.meta.url), "utf8");
    expect(tools).not.toMatch(/gmail\.send\b|sendDraft|drafts\.send/);
    const generated = readFileSync(new URL("../src/workflows/generated.ts", import.meta.url), "utf8");
    expect(generated).not.toMatch(/\.send\(|sendDraft/);
  });

  it("a Claude draft stays a draft until it's sent by hand", async () => {
    const { hub } = testHub();
    const ref = await createGeneratedDraft(hub, { to: ["a@b.example"], bcc: [], subject: "Follow-up", body: "Hi", attachments: [] });
    expect((await hub.gmail.draftStatus(ref)).state).toBe("draft");
    const t = await hub.gmail.getThread(ref.id);
    expect(t.messages[0].labelIds).toContain("DRAFT");
    await hub.gmail.sendDraft!(ref.id);
    expect((await hub.gmail.draftStatus(ref)).state).toBe("sent");
  });
});
