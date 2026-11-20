import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { buildMime, cleanHtml, messageHtml, messageText } from "../src/connectors/gmail/mime.js";
import { discardCompose, keepUpload, saveCompose } from "../src/workflows/compose.js";
import { testHub } from "./helpers.js";

const part = (mime: string, type: string) => {
  const m = mime.split(`Content-Type: ${type}`)[1].split("\r\n\r\n")[1].split("\r\n--")[0];
  return Buffer.from(m.replace(/\r\n/g, ""), "base64").toString("utf8");
};

describe("the compose box's draft", () => {
  it("makes one Gmail draft and keeps updating that same draft as you type", async () => {
    const { hub } = testHub();
    const a = await saveCompose(hub, { to: "Alex Adjuster <alex@carrier.example>", subject: "Photos", html: "<div>Hi Alex,</div>", body: "Hi Alex," });
    const b = await saveCompose(hub, { draftId: a.draftId, header: a.header, to: "alex@carrier.example, sam@example.com", cc: "boss@example.com", subject: "Photos", html: "<div>Hi Alex, <b>attached</b>.</div>", body: "Hi Alex, attached." });
    expect(b.draftId).toBe(a.draftId);
    const drafts = (hub.gmail as any).drafts();
    expect(drafts).toHaveLength(1);
    expect(drafts[0].input.to).toEqual(["alex@carrier.example", "sam@example.com"]);
    expect(drafts[0].input.cc).toEqual(["boss@example.com"]);
    expect(drafts[0].input.html).toContain("<b>attached</b>");
  });

  it("saves a draft with no recipient yet, and only threads a reply that answers a message", async () => {
    const { hub } = testHub();
    const seen: any[] = [];
    const orig = hub.gmail.createDraft.bind(hub.gmail);
    hub.gmail.createDraft = async (d) => (seen.push(d), orig(d));
    await saveCompose(hub, { subject: "Half written", body: "to be continued", threadId: "t1" });
    await saveCompose(hub, { to: "a@b.example", subject: "Re: X", body: "ok", threadId: "t1", inReplyTo: "<m1@x>", references: "<m0@x> <m1@x>" });
    expect(seen[0].to).toEqual([]);
    expect(seen[0].threadId).toBeUndefined();
    expect(seen[1]).toMatchObject({ threadId: "t1", inReplyTo: "<m1@x>", references: "<m0@x> <m1@x>" });
  });

  it("attaches files from the job folder and from the PC, and refuses a path outside them", async () => {
    const { hub } = testHub();
    const folder = hub.jobs.folder(9001);
    mkdirSync(path.join(folder, "estimate"), { recursive: true });
    writeFileSync(path.join(folder, "estimate", "Sample - Estimate.pdf"), "pdf");
    const tmp = path.join(mkdtempSync(path.join(os.tmpdir(), "up-")), "file");
    writeFileSync(tmp, "hello");
    const up = keepUpload(hub, tmp, "site notes?.txt");
    expect(up.name).toBe("site notes_.txt");
    const r = await saveCompose(hub, { to: "a@b.example", subject: "S", body: "B", attachments: [{ job: 9001, path: "estimate/Sample - Estimate.pdf" }, { upload: up.upload }] });
    const d = (hub.gmail as any).drafts().find((x: any) => x.ref.id === r.draftId);
    expect(d.input.attachments.map((f: string) => path.basename(f))).toEqual(["Sample - Estimate.pdf", "site notes_.txt"]);
    await expect(saveCompose(hub, { to: "a@b.example", subject: "S", body: "B", attachments: [{ upload: "../../.env" }] })).rejects.toThrow(/Attachment not found/);
    await expect(saveCompose(hub, { to: "a@b.example", subject: "S", body: "B", attachments: [{ job: 9001, path: "../../outside.txt" }] })).rejects.toThrow(/Attachment not found/);
  });

  it("keeps a reopened draft's own attachments, and Discard deletes the draft", async () => {
    const { hub } = testHub();
    const f = path.join(mkdtempSync(path.join(os.tmpdir(), "att-")), "Photo Report.pdf");
    writeFileSync(f, "report");
    const ref = await hub.gmail.createDraft({ to: ["a@b.example"], bcc: [], subject: "Report", body: "Attached.", attachments: [f] });
    const r = await saveCompose(hub, { draftMsgId: ref.id, threadId: ref.id, to: "a@b.example", subject: "Report", body: "Attached, edited.", keep: ["Photo Report.pdf"] });
    const d = (hub.gmail as any).drafts()[0];
    expect(d.input.body).toBe("Attached, edited.");
    expect(d.input.attachments.map((x: string) => path.basename(x))).toEqual(["Photo Report.pdf"]);
    expect(await discardCompose(hub, { draftId: r.draftId })).toBe(true);
    expect((hub.gmail as any).drafts()).toHaveLength(0);
    await expect(saveCompose(hub, { draftMsgId: "gone", to: "a@b.example", body: "x" })).rejects.toThrow(/isn't in Gmail any more/);
  });
});

describe("formatted email bodies", () => {
  it("puts the signature under what was typed and the quoted original under that", () => {
    const html = messageHtml({ body: "Hi", html: "<div>Hi <b>there</b></div>", quoteHtml: '<div class="gmail_quote">On Mon, X wrote:<blockquote>Old</blockquote></div>' }, "Hunter<br>Estimator");
    expect(html.indexOf("<b>there</b>")).toBeLessThan(html.indexOf("gmail_signature"));
    expect(html.indexOf("gmail_signature")).toBeLessThan(html.indexOf("gmail_quote\">On Mon"));
    const text = messageText({ body: "Hi there", quoteHtml: "<div>On Mon, X wrote:</div><blockquote>Old</blockquote>" }, "Hunter<br>Estimator");
    expect(text).toBe("Hi there\n\n-- \nHunter\nEstimator\n\n> On Mon, X wrote:\n> Old");
  });

  it("leaves plain drafts (the AI's) exactly as before", () => {
    expect(messageHtml({ body: "Hi Sam,\n\nThanks." }, "Sig")).toBe('<div dir="ltr"><div>Hi Sam,</div><div><br></div><div>Thanks.</div><br><div>-- </div><div class="gmail_signature">Sig</div></div>');
  });

  it("strips anything that could run from what's sent", () => {
    const out = cleanHtml('<div onclick="x()">Hi<script>alert(1)</script><a href="javascript:evil()">link</a><img src=x onerror=alert(1)></div>');
    expect(out).not.toMatch(/script|onclick|onerror|javascript:/i);
    expect(out).toContain("Hi");
  });

  it("builds a message with both a formatted and a plain version, and no empty To line", () => {
    const mime = buildMime({ to: [], bcc: [], subject: "Draft", body: "Bold move", html: "<div><b>Bold</b> move</div>", attachments: [], from: "Hunter <h@x.example>", messageId: "<1@x>" });
    expect(mime).not.toMatch(/^To:/m);
    expect(part(mime, "text/html")).toContain("<b>Bold</b> move");
    expect(part(mime, "text/plain")).toBe("Bold move");
  });
});
