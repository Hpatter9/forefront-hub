import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { MockGemini } from "../src/connectors/gemini/index.js";
import { jobDossier } from "../src/workflows/dossier.js";
import { checkFacts } from "../src/workflows/estimateCheck.js";
import { fetchItelReports, itelLine, itelReports } from "../src/workflows/itel.js";
import { ESTIMATOR_DIR, PYTHON, testHub } from "./helpers.js";

const ITEL = { material: "Carpet", rooms: ["Bedroom 2"], sample: "Nylon cut pile, 40 oz", matched: "Shaw Anso Caress, Ivory", unitPrice: 3.14, unit: "SF", includesInstall: "no", reportNumber: "4412-883", date: "2026-11-02", notes: "" };

/** A made-up job with an ITEL email (a real little PDF attached) and one from another job. */
function setup() {
  const t = testHub();
  t.hub.cfg.hubRoot = process.cwd();
  t.hub.cfg.skillDir = path.join(ESTIMATOR_DIR, "skill", "forefront-estimate");
  t.hub.cfg.ai = { provider: "gemini", geminiKey: "k", geminiModel: "main", geminiFastModel: "fast" };
  t.hub.jobs.upsert(9001, { name: "Sample", address: "123 Main St, Denver, CO 80211", claimNumber: "EX-12345", carrier: "Acme Mutual", insurance: "claim", adjuster: { name: "Alex Adjuster", email: "alex.adjuster@carrier.example", phone: "", company: "", attention: "" } });
  const pdf = path.join(t.hub.cfg.stateDir, "itel.pdf");
  mkdirSync(t.hub.cfg.stateDir, { recursive: true });
  execFileSync(PYTHON, ["-c", "import sys\nfrom reportlab.pdfgen import canvas\nc=canvas.Canvas(sys.argv[1]); c.drawString(72,720,'ITEL Laboratories - Flooring Analysis Report 4412-883'); c.drawString(72,700,'Claim EX-12345, Bedroom 2 carpet. LKQ: Shaw Anso Caress, Ivory, $3.14/SF material only'); c.save()", pdf]);
  const mail = [
    { id: "itel-1", labelIds: ["INBOX"], messages: [{ id: "im1", from: "Alex Adjuster <alex.adjuster@carrier.example>", to: ["hunter@forefrontteam.com"], cc: [], date: "2026-11-03T15:00:00Z", subject: "FW: ITEL report - Claim EX-12345", body: "Hunter, the ITEL for the bedroom carpet is attached.", attachments: [{ id: "a1", filename: "ITEL 4412-883.pdf", mimeType: "application/pdf" }] }] },
    { id: "itel-2", labelIds: ["INBOX"], messages: [{ id: "im2", from: "reports@itelinc.example", to: ["someone@else.example"], cc: [], date: "2026-11-03T15:00:00Z", subject: "ITEL report - Claim ZZ-999 - 9 Elsewhere Rd", body: "Report attached.", attachments: [{ id: "a2", filename: "ITEL 9999.pdf", mimeType: "application/pdf" }] }] },
  ];
  writeFileSync(path.join(t.hub.cfg.stateDir, "mock-mail.json"), JSON.stringify(mail));
  (t.hub.gmail as any).attachment = async () => readFileSync(pdf);
  t.hub.gemini = new MockGemini((req) => (req.jsonSchema && JSON.stringify(req.contents).includes("4412-883") ? JSON.stringify(ITEL) : JSON.stringify({ tasks: [], findings: [], summary: "", points: [], photos: [] })));
  return t;
}

describe("ITEL reports", () => {
  it("are found in the job's email, saved in files/ITEL and summarised; another job's report is left alone", async () => {
    const { hub } = setup();
    expect(await fetchItelReports(hub, 9001)).toEqual(["files/ITEL/2026-11-03 ITEL 4412-883.pdf"]);
    expect(existsSync(path.join(hub.jobs.folder(9001), "files", "ITEL", "2026-11-03 ITEL 4412-883.pdf"))).toBe(true);
    expect(await fetchItelReports(hub, 9001)).toEqual([]); // not saved twice
    const [r] = await itelReports(hub, 9001);
    expect(r).toMatchObject({ file: "files/ITEL/2026-11-03 ITEL 4412-883.pdf", summary: { material: "Carpet", rooms: ["Bedroom 2"], unitPrice: 3.14, unit: "SF", includesInstall: "no" } });
    expect(JSON.stringify((hub.gemini as MockGemini).requests.find((q) => q.jsonSchema?.properties && "material" in (q.jsonSchema.properties as object)))).toContain("Shaw Anso Caress");
    expect(itelLine(r)).toBe("2026-11-03 ITEL 4412-883.pdf: Carpet in Bedroom 2; matched Shaw Anso Caress, Ivory at $3.14/SF (material only), report 4412-883");
  });

  it("are in the job review the estimator reads first", async () => {
    const { hub } = setup();
    const d = await jobDossier(hub, 9001);
    expect(d.itel.map((r) => r.summary?.matched)).toEqual(["Shaw Anso Caress, Ivory"]);
    expect(d.missing.join(" ")).not.toMatch(/No ITEL report/);
  });

  it("the free estimate check knows about them", () => {
    const { hub } = setup();
    const itel = [{ material: "Carpet", unitPrice: 3.14, unit: "SF", file: "files/ITEL/x.pdf" }];
    const est = (items: object[]) => ({ rooms: [{ name: "Bedroom 2", floor_sf: 120 }], sections: [{ name: "Bedroom 2", items }] });
    const ok = checkFacts(hub, est([{ description: "Carpet", quantity: 120, unit: "SF", unit_price: 3.14, price_source: "itel" }]), itel);
    expect(ok.pricesOk).toBe(1);
    expect(ok.findings.filter((f) => /ITEL/.test(f.what))).toEqual([]);
    const off = checkFacts(hub, est([{ description: "Carpet", quantity: 120, unit: "SF", unit_price: 28.26, price_source: "itel" }]), itel);
    expect(off.findings.map((f) => f.what).join(" ")).toMatch(/priced \$28\.26 "per ITEL", but the job's ITEL report says \$3\.14.*per SY vs per SF/);
    const missed = checkFacts(hub, est([{ description: "Carpet", quantity: 120, unit: "SF", unit_price: 4.5, price_source: "price_list" }]), itel);
    expect(missed.findings.map((f) => f.what).join(" ")).toMatch(/isn't priced from the ITEL report for Carpet/);
    const none = checkFacts(hub, est([{ description: "Carpet", quantity: 120, unit: "SF", unit_price: 3.14, price_source: "itel" }]), []);
    expect(none.findings.map((f) => f.what).join(" ")).toMatch(/there's no ITEL report on the job/);
  });
});
