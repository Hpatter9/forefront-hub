import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { MockGemini } from "../src/connectors/gemini/index.js";
import { estimatorSystem, estimatorTools, forSaving, geminiEstimate, lighten } from "../src/agent/geminiEstimator.js";
import { Studio } from "../src/agent/studio.js";
import { ESTIMATOR_DIR, testHub } from "./helpers.js";

function setup(answer = true) {
  const t = testHub(answer);
  t.hub.cfg.skillDir = path.join(ESTIMATOR_DIR, "skill", "forefront-estimate");
  t.hub.cfg.ai = { provider: "gemini", geminiKey: "k", geminiModel: "main", geminiFastModel: "fast", geminiFallbacks: ["lite"] };
  t.hub.jobs.upsert(6500, { name: "Sample", address: "123 Main St, Denver, CO" });
  const put = (rel: string, text: string) => { const f = path.join(t.hub.jobs.folder(6500), rel); mkdirSync(path.dirname(f), { recursive: true }); writeFileSync(f, text); return f; };
  return { ...t, put };
}

describe("the Estimator's tools for Gemini", () => {
  it("reads the job folder and the skill, and nothing else", async () => {
    const { hub, put } = setup();
    put("notes/notes.txt", "Hall bath, 5 by 8.");
    const tools = estimatorTools(hub, 6500);
    expect((await tools.run("read_file", { path: "notes/notes.txt" })).result).toBe("Hall bath, 5 by 8.");
    expect((await tools.run("read_file", { path: "skill/references/scoping_guide.md" })).result.length).toBeGreaterThan(500);
    expect((await tools.run("read_file", { path: "../../.env" })).result).toMatch(/Only this job's folder/);
    expect((await tools.run("read_file", { path: "/etc/passwd" })).result).toMatch(/Only this job's folder/);
    expect(JSON.parse((await tools.run("list_files", { dir: "skill/scripts" })).result).join(" ")).toContain("render.py");
  });

  it("writes only inside the job folder, and asks before replacing an estimate (keeping the old one)", async () => {
    const yes = setup(true);
    const tools = estimatorTools(yes.hub, 6500);
    expect((await tools.run("write_file", { path: "skill/SKILL.md", content: "x" })).result).toMatch(/only be written inside this job/);
    expect((await tools.run("write_file", { path: "../other/x.txt", content: "x" })).result).toMatch(/only be written inside this job/);
    expect((await tools.run("write_file", { path: "estimate/estimate.json", content: "{\"v\":1}" })).result).toMatch(/Wrote estimate\/estimate.json/);
    expect((await tools.run("write_file", { path: "estimate/estimate.json", content: "{\"v\":2}" })).result).toMatch(/Wrote/);
    expect(readFileSync(path.join(yes.hub.jobs.folder(6500), "estimate", "revisions", "v1", "estimate.json"), "utf8")).toBe("{\"v\":1}");
    const no = setup(false);
    no.put("estimate/estimate.json", "{\"v\":1}");
    expect((await estimatorTools(no.hub, 6500).run("write_file", { path: "estimate/estimate.json", content: "{\"v\":2}" })).result).toMatch(/Hunter said not to overwrite/);
    expect(readFileSync(path.join(no.hub.jobs.folder(6500), "estimate", "estimate.json"), "utf8")).toBe("{\"v\":1}");
  });

  it("runs only the skill's own scripts, and shows photos as pictures", async () => {
    const { hub, put } = setup();
    const tools = estimatorTools(hub, 6500);
    expect((await tools.run("run_script", { script: "rm.py", args: [] })).result).toMatch(/Only these scripts/);
    expect((await tools.run("run_script", { script: "price_lookup.py", args: ["/etc/passwd"] })).result).toMatch(/outside the job folder/);
    const out = (await tools.run("run_script", { script: "price_lookup.py", args: ["baseboard"] })).result;
    expect(out).toMatch(/baseboard/i);
    put("photos/a.png", "not really a png");
    const v = await tools.run("view_files", { paths: ["photos/a.png", "photos/missing.jpg", "notes/notes.txt"] });
    expect(v.media).toEqual([{ mimeType: "image/png", data: Buffer.from("not really a png").toString("base64") }]);
    expect(v.result).toMatch(/missing.jpg: no such file/);
  });

  it("gives Gemini the skill's own instructions, word for word", () => {
    const { hub } = setup();
    const sys = estimatorSystem(hub, 6500);
    expect(sys).toContain(readFileSync(path.join(hub.cfg.skillDir, "SKILL.md"), "utf8").slice(0, 400));
    expect(sys).toMatch(/Prices come only from price_lookup.py/);
  });
});

describe("Gemini writing in the Estimator", () => {
  it("works through tool calls to an answer, shows photos beside the result, and keeps the conversation without them", async () => {
    const { hub, put } = setup();
    put("photos/a.png", "png");
    const script = [
      { calls: [{ name: "view_files", args: { paths: ["photos/a.png"] } }] },
      { text: "Writing it down.", calls: [{ name: "write_file", args: { path: "notes/scope.txt", content: "Hall bath" } }] },
      { text: "Done: I wrote notes/scope.txt." },
    ];
    hub.gemini = new MockGemini((_req, n) => script[n]);
    const steps: string[] = [], said: string[] = [];
    const r = await geminiEstimate(hub, 6500, "Scope the hall bath", { onStep: (l) => steps.push(l), onText: (t) => said.push(t) });
    expect(r.text).toBe("Done: I wrote notes/scope.txt.");
    expect(steps).toEqual(["Looking at a.png", "Writing scope.txt"]);
    expect(said).toEqual(["Writing it down."]);
    expect(existsSync(path.join(hub.jobs.folder(6500), "notes", "scope.txt"))).toBe(true);
    const second = (hub.gemini as MockGemini).requests[1];
    expect(second.contents.at(-1)!.parts.some((p: any) => p.inlineData?.mimeType === "image/png")).toBe(true);
    expect(second.tools!.map((t) => t.name)).toEqual(expect.arrayContaining(["run_script", "read_file", "job_review"]));
    expect(second.tools!.some((t) => /gmail_create_draft|homebase_set_stage|calendar_create/.test(t.name))).toBe(false);
    expect(JSON.stringify(forSaving(r.contents))).not.toContain("inlineData");
  });

  it("drops photos from older rounds but keeps the skill's reference files whole", () => {
    const long = "x".repeat(9000);
    const round = (name: string, extra: any = {}) => ({ role: "user" as const, parts: [{ functionResponse: { name, response: { result: long, ...extra } } }, { inlineData: { mimeType: "image/png", data: "AAAA" } }] });
    const contents = [round("job_review"), round("read_file", { keep: true }), round("a"), round("b")];
    lighten(contents);
    expect(contents[0].parts.some((p: any) => p.inlineData)).toBe(false);
    expect((contents[0].parts[0] as any).functionResponse.response.result.length).toBeLessThan(6100);
    expect((contents[1].parts[0] as any).functionResponse.response.result.length).toBe(9000);
    expect(contents[3].parts.some((p: any) => p.inlineData)).toBe(true);
  });

  it("the Estimator tab's conversation records Gemini as the writer and carries on from where it left off", async () => {
    const { hub } = setup();
    const script = [{ text: "Which room?" }, { text: "Got it: the hall bath." }];
    hub.gemini = new MockGemini((_req, n) => script[n]);
    const studio = new Studio(hub, () => {});
    await studio.send(6500, "New estimate", "gemini");
    await studio.send(6500, "The hall bath", "gemini");
    const v = studio.view(6500);
    expect(v.writer).toBe("gemini");
    expect(v.turns.filter((t) => t.role === "assistant").map((t) => t.text.split("\n")[0])).toEqual(["Which room?", "Got it: the hall bath."]);
    expect(v.turns.at(-1)!.text).toMatch(/Written by Gemini: main\. This is a trial/);
    // The second message went to Gemini with the first exchange in front of it.
    expect((hub.gemini as MockGemini).requests[1].contents.map((c) => c.parts[0].text)).toEqual(["New estimate", "Which room?", "The hall bath"]);
  });
});
