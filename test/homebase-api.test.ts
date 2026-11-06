import { describe, expect, it } from "vitest";
import { ApiHomebase } from "../src/connectors/homebase/api.js";

/** A fake Homebase answering like the real /api/v1 (shapes copied from live reads on 2026-11-05). */
function fakeHomebase() {
  const calls: { method: string; url: string; headers: Record<string, string>; body?: any }[] = [];
  const job = {
    id: "07509ea9-788e-4e24-9d4d-55da79f4e6e6",
    jobNumber: "3226",
    name: "Augustine - 1071 Acapulco Ct - Colorado Springs - Recon",
    customer: "Augustine",
    stage: "Estimating",
    address: { street: "1071 Acapulco Ct", unit: null, city: "Colorado Springs", state: "CO", zip: "80910" },
    owner: "Jennifer Schultenover",
    projectManager: "Erick Quintana",
    modifiedAt: "2026-10-27T19:59:05.235Z",
  };
  const detail = {
    ...job,
    dates: { stageChanged: "2026-11-05" },
    money: { proposalAmount: null, proposalSubmittedOn: null, contractAmount: null },
    people: { owner: "Jennifer Schultenover", projectManager: "Erick Quintana", estimator: "Hunter Patterson" },
    contacts: [{ id: "c1", name: "Jeremy Augustine", email: "jeremyaugustine07@gmail.com", phone: "7193960103", roles: ["Primary"], isPrimary: true }],
    brief: { claimNumber: "5045106171-1", carrier: { id: "a1", name: "Farmers" }, adjuster1: { name: "Eileen Brandt", email: "eileen@claims.example", phone: "719-418-9596" }, picturesLink: "https://app.companycam.com/projects/117697136" },
  };
  const fetchFn = (async (url: string, init: any = {}) => {
    const body = init.body && typeof init.body === "string" ? JSON.parse(init.body) : undefined;
    calls.push({ method: init.method ?? "GET", url, headers: init.headers ?? {}, body });
    const u = new URL(url);
    const json = (o: unknown, status = 200) => new Response(JSON.stringify(o), { status, headers: { "content-type": "application/json" } });
    if (u.pathname === "/api/v1/projects") return json({ ok: true, count: 1, more: false, projects: [job] });
    if (u.pathname === `/api/v1/projects/${job.id}` && init.method === "PATCH") return json({ ok: true, id: job.id, changed: 1, results: { proposalAmount: { ok: true, changed: true } } });
    if (u.pathname === `/api/v1/projects/${job.id}`) return json({ ok: true, project: detail });
    if (u.pathname.endsWith("/notes") && init.method !== "POST") return json({ ok: true, count: 0, notes: [] });
    if (u.pathname.endsWith("/stage")) return body.fromStage === detail.stage ? json({ ok: true, changed: true, from: detail.stage, to: body.stage }) : json({ ok: false, error: { code: "stage_changed", message: "moved" } }, 409);
    if (u.pathname.endsWith("/activity") || u.pathname.endsWith("/notes")) return json({ ok: true }, 201);
    return json({ ok: false, error: { code: "no_such_route", message: u.pathname } }, 404);
  }) as typeof fetch;
  return { calls, fetchFn };
}

describe("Homebase API driver", () => {
  it("reads a job: contacts, adjuster from the brief, claim, CompanyCam link, days in stage", async () => {
    const { calls, fetchFn } = fakeHomebase();
    const hb = new ApiHomebase({ url: "https://hb", token: "hbk_x", actingEmail: "hunter@forefrontteam.com", fetch: fetchFn });
    const j = await hb.getJob(3226);
    expect(j).toMatchObject({ jobNumber: 3226, name: "Augustine", stage: "Estimating", stageSince: "2026-11-05", claimNumber: "5045106171-1", carrier: "Farmers", picturesLink: "https://app.companycam.com/projects/117697136", intakeEmail: "office+3226@forefrontteam.com" });
    expect(j.contacts).toMatchObject([
      { role: "customer", name: "Jeremy Augustine", email: "jeremyaugustine07@gmail.com", phone: "7193960103" },
      { role: "adjuster", name: "Eileen Brandt", email: "eileen@claims.example", phone: "719-418-9596" },
    ]);
    expect(calls[0].headers).toMatchObject({ Authorization: "Bearer hbk_x", "X-Acting-User-Email": "hunter@forefrontteam.com" });
  });

  it("writes the proposal amount (Homebase stamps the date), moves the stage with fromStage, logs calls as activity", async () => {
    const { calls, fetchFn } = fakeHomebase();
    const hb = new ApiHomebase({ url: "https://hb", token: "hbk_x", fetch: fetchFn });
    await hb.setProposal(3226, { amount: 3162.87, submittedAt: "2026-11-05" });
    await hb.setStage(3226, "Proposal Submitted", "Estimating");
    await hb.addNote(3226, { kind: "call", body: "Left VM for Eileen\nAsked for her email", who: "Eileen Brandt" });
    const writes = calls.filter((c) => c.method !== "GET");
    expect(writes.map((c) => [c.method, new URL(c.url).pathname, c.body])).toEqual([
      ["PATCH", "/api/v1/projects/07509ea9-788e-4e24-9d4d-55da79f4e6e6", { proposalAmount: "3162.87" }],
      ["PATCH", "/api/v1/projects/07509ea9-788e-4e24-9d4d-55da79f4e6e6/stage", { stage: "Proposal Submitted", fromStage: "Estimating" }],
      ["POST", "/api/v1/projects/07509ea9-788e-4e24-9d4d-55da79f4e6e6/activity", { kind: "call", direction: "Outbound", who: "Eileen Brandt", subject: "Left VM for Eileen", details: "Asked for her email" }],
    ]);
    for (const w of writes) expect(w.headers["Idempotency-Key"]).toMatch(/^hub:/);
  });

  it("refuses a stage move when the job moved meanwhile", async () => {
    const { fetchFn } = fakeHomebase();
    const hb = new ApiHomebase({ url: "https://hb", token: "hbk_x", fetch: fetchFn });
    await expect(hb.setStage(3226, "Job Won", "Proposal Review")).rejects.toThrow(/409 stage_changed/);
  });

  it("filters to my jobs by estimator / PM / owner", async () => {
    const { fetchFn } = fakeHomebase();
    const hb = new ApiHomebase({ url: "https://hb", token: "hbk_x", fetch: fetchFn });
    expect((await hb.listJobs({ mine: "Hunter Patterson" })).map((j) => j.jobNumber)).toEqual([3226]);
    expect(await hb.listJobs({ mine: "Somebody Else" })).toEqual([]);
  });
});
