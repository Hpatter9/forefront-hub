import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { fileMessage, inboxState, matchJob } from "../src/workflows/inbox.js";
import { pullJob } from "../src/workflows/pull.js";
import { addFile, placeFor } from "../src/workflows/uploads.js";
import { testHub } from "./helpers.js";

const msg = (o: Partial<{ from: string; subject: string; body: string }>) => ({ id: "m1", from: o.from ?? "Someone <x@y.com>", to: ["hunter@forefrontteam.com"], cc: [], date: "2026-11-06T15:00:00Z", subject: o.subject ?? "", body: o.body ?? "", attachments: [] });

describe("matching incoming email to a job", () => {
  it("is sure on a job number, a claim number, or the job's adjuster; unsure otherwise", async () => {
    const { hub } = testHub(true);
    await pullJob(hub, 9001);
    await pullJob(hub, 9002);
    expect((await matchJob(hub, msg({ subject: "Re: #9002 schedule" }))).jobNumber).toBe(9002);
    expect((await matchJob(hub, msg({ body: "Regarding claim EX-12345, approved." }))).jobNumber).toBe(9001);
    expect((await matchJob(hub, msg({ from: "Alex Adjuster <alex.adjuster@carrier.example>", subject: "photos?" }))).jobNumber).toBe(9001);
    expect((await matchJob(hub, msg({ from: "stranger@else.com", subject: "hello" }))).jobNumber).toBeUndefined();
  });

  it("files by forwarding to the job's office+ address in Gmail's forward format", async () => {
    const { hub, root } = testHub(true);
    await pullJob(hub, 9001);
    await fileMessage(hub, "mock-thread-1", "m1", 9001);
    const sent = JSON.parse(readFileSync(path.join(hub.cfg.stateDir, "mock-mail.json"), "utf8")).flatMap((t: any) => t.messages).find((m: any) => m.to[0] === "office+9001@forefrontteam.com");
    expect(sent.subject).toMatch(/^Fwd: RE: Sample/);
    expect(sent.body).toMatch(/^---------- Forwarded message ---------\nFrom: Alex Adjuster <alex.adjuster@carrier.example>\nDate: /);
    expect(inboxState(hub).filed.m1.jobNumber).toBe(9001);
    expect(root).toBeTruthy();
  });
});

describe("adding files by hand", () => {
  it("puts each file where it belongs and asks before Homebase", async () => {
    expect(placeFor("5625744v2.ESX")).toEqual({ sub: "sketch", kind: "scope" });
    expect(placeFor("IMG_2231.JPG")).toEqual({ sub: "photos", kind: "photo" });
    expect(placeFor("Augustine - Xactimate Estimate.pdf")).toEqual({ sub: "estimate", kind: "estimate" });
    expect(placeFor("ITEL flooring report.pdf")).toEqual({ sub: "files", kind: "report" });
    const { hub, homebase, approver } = testHub(true);
    await pullJob(hub, 9001);
    const r = await addFile(hub, 9001, "Signed Agreement.pdf", Buffer.from("%PDF-1.4"));
    expect(r).toMatchObject({ sub: "files", kind: "contract", uploaded: true });
    expect(approver.asked.at(-1)!.action).toMatch(/Also add Signed Agreement.pdf to the Documents tab of Homebase #9001/);
    expect(homebase.writes.at(-1)).toMatchObject({ op: "uploadDocument", args: { file: "Signed Agreement.pdf", kind: "contract" } });
  });
});

describe("copies forwarded to Homebase stay out of Sent", () => {
  it("hides a lone forward to the office+ address, and keeps real emails that only BCC it", async () => {
    const { isHomebaseLog } = await import("../src/workflows/inbox.js");
    expect(isHomebaseLog({ to: "office+3184@forefrontteam.com", messageCount: 1 })).toBe(true);
    expect(isHomebaseLog({ to: "Homebase <office+3184@forefrontteam.com>", cc: "", messageCount: 1 })).toBe(true);
    expect(isHomebaseLog({ to: "Dana Forbes <dana@example.com>", messageCount: 1 })).toBe(false);
    expect(isHomebaseLog({ to: "dana@example.com, office+3184@forefrontteam.com", messageCount: 1 })).toBe(false);
    expect(isHomebaseLog({ to: "office+3184@forefrontteam.com", messageCount: 3 })).toBe(false);
    expect(isHomebaseLog({ messageCount: 1 })).toBe(false);
  });
});
