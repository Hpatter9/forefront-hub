import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { pickProject, RestCompanyCam } from "../src/connectors/companycam/index.js";
import { parseDeliverySubject } from "../src/connectors/docusketch/index.js";
import { buildMime, encodeHeader } from "../src/connectors/gmail/mime.js";
import { parseDashboard, parseJobPage } from "../src/connectors/homebase/parse.js";
import { parseTotals } from "../src/connectors/skill/index.js";
import { firstName, JobStore, lastName } from "../src/core/job.js";
import { toLocalDate } from "../src/workflows/sync.js";

const tmp = () => path.join(os.tmpdir(), `hub-core-${Math.random().toString(36).slice(2)}`);

describe("job folder", () => {
  it("creates '<job#> <Name>' with subfolders, merges patches, and clears with null", () => {
    const store = new JobStore(tmp());
    store.upsert(3226, { name: "Augustine", address: "1071 Acapulco Ct", customer: { name: "Jeremy Augustine", email: "j@x.com", phone: "" } });
    expect(path.basename(store.folder(3226))).toBe("3226 Augustine");
    expect(existsSync(store.path(3226, "photos"))).toBe(true);
    const j = store.upsert(3226, { customer: { email: "new@x.com" } as any, sendoff: { drafts: [], homebaseLoggedAt: "2026-11-05" } });
    expect(j.customer).toEqual({ name: "Jeremy Augustine", email: "new@x.com", phone: "", company: "", attention: "" });
    expect(store.upsert(3226, { sendoff: { homebaseLoggedAt: null } }).sendoff.homebaseLoggedAt).toBeUndefined();
    expect(store.list().map((x) => x.jobNumber)).toEqual([3226]);
  });

  it("snapshots the estimate into revisions/v1, v2", () => {
    const store = new JobStore(tmp());
    store.upsert(1, { name: "A" });
    writeFileSync(store.path(1, "estimate", "estimate.json"), "{}");
    expect(path.basename(store.snapshotEstimate(1)!)).toBe("v1");
    expect(path.basename(store.snapshotEstimate(1)!)).toBe("v2");
  });

  it("names", () => {
    expect(lastName("Jeremy Augustine")).toBe("Augustine");
    expect(lastName("Doe, Jane")).toBe("Doe");
    expect(firstName("Doe, Jane")).toBe("Jane");
  });
});

describe("gmail mime", () => {
  it("has BCC, encoded subject and real attachments", () => {
    const dir = tmp();
    mkdirSync(dir, { recursive: true });
    const pdf = path.join(dir, "Augustine - Xactimate Estimate.pdf");
    writeFileSync(pdf, "%PDF-1.4 test");
    const raw = buildMime({ from: "Hunter <h@f.com>", to: ["a@b.com"], bcc: ["office+3226@forefrontteam.com"], subject: "Augustine – 1071 Acapulco Ct – Repair Estimate", body: "Hi Eileen,\n\nAttached.", attachments: [pdf], messageId: "<x@y>", signatureHtml: "Hunter<br>Estimator" });
    expect(raw).toContain("Bcc: office+3226@forefrontteam.com");
    expect(raw).toContain(`Subject: ${encodeHeader("Augustine – 1071 Acapulco Ct – Repair Estimate")}`);
    expect(raw).toContain('filename="Augustine - Xactimate Estimate.pdf"');
    expect(raw).toContain(Buffer.from("%PDF-1.4 test").toString("base64"));
  });
});

describe("homebase parsing", () => {
  it("reads job number, stage and days from dashboard rows", () => {
    const jobs = parseDashboard(
      [
        { href: "https://hb/projects/0a1b2c3d-0000-4000-8000-000000000001", text: "#3226 Augustine", rowText: "#3226 Augustine 1071 Acapulco Ct Proposal Submitted 3 days" },
        { href: "https://hb/settings", text: "Settings", rowText: "" },
      ],
      "https://hb",
    );
    expect(jobs).toHaveLength(1);
    expect(jobs[0]).toMatchObject({ jobNumber: 3226, stage: "Proposal Submitted", id: "0a1b2c3d-0000-4000-8000-000000000001" });
    expect(jobs[0].stageSince).toBeTruthy();
  });

  it("reads the intake bcc, contacts and financials from a job page", () => {
    const text = "#3226 Augustine\nStage: Estimating\nCarrier: Farmers\nClaim Number: 5045106171-1\nProposal amount: $3,162.87\nCustomer\nJeremy Augustine\njeremyaugustine07@gmail.com\nAdjuster\nEileen Brandt\nnina.brandt@yourclaim.com";
    const d = parseJobPage(text, [{ href: "mailto:jeremyaugustine07@gmail.com?bcc=office%2B3226%40forefrontteam.com", text: "Email", rowText: "" }], "https://hb/projects/0a1b2c3d-0000-4000-8000-000000000001");
    expect(d).toMatchObject({ jobNumber: 3226, stage: "Estimating", carrier: "Farmers", claimNumber: "5045106171-1", proposalAmount: 3162.87, intakeEmail: "office+3226@forefrontteam.com" });
    expect(d.contacts.find((c) => c.role === "adjuster")?.email).toBe("nina.brandt@yourclaim.com");
    expect(d.contacts.find((c) => c.role === "customer")?.name).toBe("Jeremy Augustine");
  });
});

describe("companycam + docusketch", () => {
  it("picks the project by job number, then street", () => {
    const ps = [
      { id: "1", name: "3100 - Other - 9 Elm", address: "9 Elm St", photoCount: 1, url: "" },
      { id: "117697136", name: "3226 - Augustine - 1071 Acapulco Ct - Colorado Springs - Recon", address: "1071 Acapulco Ct, Colorado Springs, CO, 80910", photoCount: 7, url: "" },
    ];
    expect(pickProject(ps, 3226)?.id).toBe("117697136");
    expect(pickProject(ps, 9999, "1071 Acapulco Ct, Colorado Springs")?.id).toBe("117697136");
  });

  it("maps the v2 photo shape", async () => {
    const fake = (async (url: string) =>
      new Response(JSON.stringify(url.includes("/photos") ? [{ id: 37, captured_at: "2026-10-28T16:25:30Z", description: null, creator_name: "Erick", uris: [{ type: "original", uri: "https://img/o.jpg" }, { type: "web", uri: "https://img/w.jpg" }], photo_url: "https://app/p/37" }] : []))) as typeof fetch;
    const photos = await new RestCompanyCam("t", fake).listPhotos("117697136");
    expect(photos[0]).toMatchObject({ id: "37", original: "https://img/o.jpg", creator: "Erick", capturedAt: "2026-10-28T16:25:30.000Z" });
  });

  it("reads the DocuSketch project id from the delivery subject", () => {
    expect(parseDeliverySubject("Sketch request for the project 5625744 delivered")).toBe("5625744");
    expect(parseDeliverySubject("Sketch request for the project 5625744 created")).toBeNull();
  });
});

describe("skill output", () => {
  it("parses render.py totals", () => {
    const out = "Markup on customer documents: 5%   O&P: 20%\nBase Scope: $3,162.87  (Xactimate-style, no markup: $3,012.26)\n    Drywall   $1.00\nOptional — Pantry Repairs: $500.00  (Xactimate-style, no markup: $476.19)\n";
    expect(parseTotals(out)).toEqual([
      { title: "Base Scope", customerTotal: 3162.87, xactimateTotal: 3012.26 },
      { title: "Optional — Pantry Repairs", customerTotal: 500, xactimateTotal: 476.19 },
    ]);
  });

  it("uses Colorado dates", () => {
    expect(toLocalDate("2026-11-06T03:30:00Z")).toBe("2026-11-05");
  });
});

