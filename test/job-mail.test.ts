import { describe, expect, it } from "vitest";
import { MockTexts } from "../src/connectors/texts/index.js";
import { matchJob } from "../src/workflows/inbox.js";
import { allSigns, belongsToJob, jobMailQuery, summaryBelongs } from "../src/workflows/jobMail.js";
import { jobTexts, syncTexts } from "../src/workflows/texts.js";
import { testHub } from "./helpers.js";

const CLAIMS = "claims@statefarm.example";
function setup() {
  const t = testHub();
  const person = (name: string, email: string, phone = "") => ({ name, email, phone, company: "", attention: "" });
  // Two jobs with the same carrier claims inbox as their adjuster, and one with its own adjuster.
  t.hub.jobs.upsert(7101, { name: "Starr", address: "12 Aspen Ct, Monument, CO 80132", claimNumber: "11-AAA-111", customer: person("Kim Starr", "kim@starr.example", "719-555-0001"), adjuster: person("State Farm Claims", CLAIMS, "800-555-0100") });
  t.hub.jobs.upsert(7102, { name: "Young", address: "6924 Sierra Meadows Drive, Colorado Springs, CO 80908", claimNumber: "060V2R840", customer: person("Ed Young", "ed@young.example", "719-555-0002"), adjuster: person("State Farm Claims", CLAIMS, "800-555-0100") });
  t.hub.jobs.upsert(7103, { name: "Lopez", address: "3 Elm Way, Denver, CO", customer: person("Ana Lopez", "ana@lopez.example"), adjuster: person("Pat Own", "pat@other.example") });
  return { ...t, all: allSigns(t.hub, true) };
}

describe("which job an email belongs to", () => {
  it("an email to a claims address two jobs share goes only to the job it names", () => {
    const { all } = setup();
    const young = { text: "Subject: Young – 6924 Sierra Meadows Dr – Repair Estimate\nHello,\nPlease find attached our estimate for Ed Young (Claim # 060V2R840).\nhunter@x claims@statefarm.example office+7102@forefrontteam.com", people: ["hunter@forefrontteam.com", CLAIMS] };
    expect(belongsToJob(all, 7102, young.text, young.people).belongs).toBe(true);
    expect(belongsToJob(all, 7101, young.text, young.people)).toMatchObject({ belongs: false, why: expect.stringContaining("#7102") });
  });

  it("a shared address with nothing that says which job belongs to neither; a customer's name settles it", () => {
    const { all } = setup();
    expect(belongsToJob(all, 7101, "Following up on the review. Thanks!", [CLAIMS]).belongs).toBe(false);
    expect(belongsToJob(all, 7102, "Following up on the review. Thanks!", [CLAIMS]).belongs).toBe(false);
    expect(belongsToJob(all, 7101, "Any update on the Starr claim?", [CLAIMS]).belongs).toBe(true);
    expect(belongsToJob(all, 7102, "Any update on the Starr claim?", [CLAIMS]).belongs).toBe(false);
  });

  it("someone who's only on one job still counts on their address alone, and strangers never do", () => {
    const { all } = setup();
    expect(belongsToJob(all, 7103, "Quick question", ["pat@other.example"]).belongs).toBe(true);
    expect(belongsToJob(all, 7101, "Sounds good, thanks", ["Kim Starr <kim@starr.example>"]).belongs).toBe(true);
    expect(belongsToJob(all, 7101, "Lunch?", ["friend@gmail.example"]).belongs).toBe(false);
    // ...unless the email is plainly about another job.
    expect(belongsToJob(all, 7101, "Forwarding the Young photos, 6924 Sierra Meadows", ["kim@starr.example"]).belongs).toBe(false);
  });

  it("works on search results too, and searches a shared address only together with the job's own words", () => {
    const { all } = setup();
    const sent = { subject: "Young – 6924 Sierra Meadows Drive – Repair Estimate", snippet: "Hello, Please find attached", from: "Hunter <hunter@forefrontteam.com>", to: CLAIMS, cc: "" };
    expect(summaryBelongs(all, 7101, sent)).toBe(false);
    expect(summaryBelongs(all, 7102, sent)).toBe(true);
    const q = jobMailQuery(all, 7101);
    expect(q).toContain("from:kim@starr.example");
    expect(q).toMatch(/\(\(from:claims@statefarm\.example[^)]*\) \("12 aspen" OR "11aaa111" OR "starr"\)\)/);
    expect(q).not.toMatch(/(^| OR )from:claims@statefarm\.example OR to:claims@statefarm\.example OR cc:claims@statefarm\.example( OR |$)/);
  });

  it("doesn't mistake a street number at the start of a line for a job number", async () => {
    const t = setup();
    t.hub.jobs.upsert(6924, { name: "Other", address: "1 Far Rd, Pueblo, CO" });
    const m = { id: "m", from: "someone@nowhere.example", to: [], cc: [], date: "", subject: "Estimate", body: "Property:\n6924 Sierra Meadows Drive\nColorado Springs", attachments: [] } as any;
    expect((await matchJob(t.hub, m)).jobNumber).not.toBe(6924);
    expect((await matchJob(t.hub, { ...m, body: "This is for job 7103." })).jobNumber).toBe(7103);
  });
});

describe("texts from a number that's on several jobs", () => {
  it("go to the job that day's texts name, and to none when nothing says which", async () => {
    const t = setup();
    const now = Date.now();
    t.hub.texts = new MockTexts([
      { id: "1", handle: "8005550100", fromMe: false, at: new Date(now - 2 * 864e5).toISOString(), text: "On the Young claim, can you resend the photos?" },
      { id: "2", handle: "8005550100", fromMe: true, at: new Date(now - 2 * 864e5 + 60000).toISOString(), text: "Sure, sending now" },
      { id: "3", handle: "8005550100", fromMe: false, at: new Date(now - 5 * 864e5).toISOString(), text: "Got it, thanks" },
      { id: "4", handle: "7195550001", fromMe: true, at: new Date(now - 864e5).toISOString(), text: "See you Thursday" },
    ]);
    const r = await syncTexts(t.hub);
    expect(jobTexts(t.hub, 7102).map((x) => x.text).sort()).toEqual(["On the Young claim, can you resend the photos?", "Sure, sending now"]);
    expect(jobTexts(t.hub, 7101).map((x) => x.text)).toEqual(["See you Thursday"]);
    expect(r).toMatchObject({ matched: 3, unassigned: 1 });
  });
});
