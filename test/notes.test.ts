import { describe, expect, it } from "vitest";
import { noteAuthor } from "../src/connectors/homebase/types.js";
import { pullJob, savedNotes } from "../src/workflows/pull.js";
import { testHub } from "./helpers.js";

describe("Homebase Notes", () => {
  it("reads who wrote a note from Homebase's stamp", () => {
    expect(noteAuthor("Recon Desk — Shannon Hoag")).toEqual({ person: "Shannon Hoag", via: "Recon Desk" });
    expect(noteAuthor("Hunter Patterson")).toEqual({ person: "Hunter Patterson", via: "" });
  });

  it("keeps the job's notes, with replies, in the folder when it syncs", async () => {
    const { hub } = testHub();
    await pullJob(hub, 9001, { lookups: false });
    const notes = savedNotes(hub, 9001);
    expect(notes[0].body).toContain("@Hunter Patterson");
    expect(notes[0].replies[0].author).toContain("Hunter Patterson");
  });

  it("replies under a note, one level deep", async () => {
    const { hub } = testHub();
    await hub.homebase.replyNote!(9001, "note-1", "Adjuster OK'd the bathroom first. @Sam Office");
    const feed = await hub.homebase.noteFeed!(9001);
    expect(feed.find((n) => n.id === "note-1")!.replies.at(-1)!.body).toContain("bathroom first");
    await hub.homebase.addNote(9001, { kind: "note", body: "New note" });
    expect((await hub.homebase.noteFeed!(9001))[0].body).toBe("New note");
  });
});
