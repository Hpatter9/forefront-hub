import path from "node:path";
import { describe, expect, it } from "vitest";
import { LiveGemini, MockGemini } from "../src/connectors/gemini/index.js";
import { agentAsk, aiProvider, complete } from "../src/agent/llm.js";
import { loadConfig } from "../src/core/config.js";
import { testHub } from "./helpers.js";

const geminiHub = (script: ConstructorParameters<typeof MockGemini>[0]) => {
  const t = testHub();
  t.hub.cfg.ai = { provider: "gemini", geminiKey: "test", geminiModel: "gemini-flash-latest", geminiFastModel: "gemini-flash-lite-latest" };
  t.hub.gemini = new MockGemini(script);
  return t;
};

describe("Gemini as Keystone's AI", () => {
  it("picks Gemini when there's a Gemini key, and honours HUB_AI", () => {
    expect(loadConfig({ HUB_MODE: "mock", GEMINI_API_KEY: "g" }).ai.provider).toBe("gemini");
    expect(loadConfig({ HUB_MODE: "mock", ANTHROPIC_API_KEY: "a", GEMINI_API_KEY: "g", HUB_AI: "claude" }).ai.provider).toBe("claude");
    expect(loadConfig({ HUB_MODE: "mock", HUB_AI: "gemini" }).ai.provider).toBe("off");
    // An Anthropic key alone doesn't put everyday features on the paid Claude API.
    expect(loadConfig({ HUB_MODE: "mock", ANTHROPIC_API_KEY: "sk-ant-a" }).ai.provider).toBe("off");
    expect(loadConfig({ HUB_MODE: "mock" }).ai.provider).toBe("off");
  });

  it("answers one question as JSON shaped by a schema, on the quick model when asked", async () => {
    const { hub } = geminiHub(() => '{"items":[{"n":1,"summary":"Adjuster wants hallway photos"}]}');
    const schema = { type: "object", properties: { items: { type: "array" } }, required: ["items"] };
    const r = await complete<{ items: { summary: string }[] }>(hub, { system: "sys", prompt: "p", schema, fast: true });
    expect(r.items[0].summary).toBe("Adjuster wants hallway photos");
    const req = (hub.gemini as MockGemini).requests[0];
    expect(req).toMatchObject({ model: "gemini-flash-lite-latest", system: "sys", jsonSchema: schema });
  });

  it("uses Keystone's tools by function calling, then answers", async () => {
    const steps: string[] = [];
    const { hub } = geminiHub((req, n) => (n === 0 ? { calls: [{ name: "job_list", args: {} }] } : `You have ${JSON.parse(String(req.contents.at(-1)!.parts[0].functionResponse!.response.result)).length} job folders.`));
    hub.jobs.upsert(3226, { name: "Augustine" });
    const text = await agentAsk(hub, "How many job folders do I have?", { onMessage: (m: any) => m.message?.content?.forEach((c: any) => c.type === "tool_use" && steps.push(c.name)) });
    expect(text).toBe("You have 1 job folders.");
    expect(steps).toEqual(["mcp__hub__job_list"]);
    const first = (hub.gemini as MockGemini).requests[0];
    expect(first.tools!.map((t) => t.name)).toContain("gmail_create_draft");
    expect(first.tools!.map((t) => t.name)).not.toContain("gmail_send");
    expect(first.tools!.find((t) => t.name === "job_get")!.parametersJsonSchema).toMatchObject({ type: "object", properties: { jobNumber: { type: "integer" } } });
  });

  it("sends Google the JSON Schema and tools, and waits and retries when Google says slow down", async () => {
    const sent: any[] = [];
    let n = 0;
    const fake = (async (_url: string, init: any) => {
      sent.push(JSON.parse(init.body));
      return n++ === 0
        ? new Response(JSON.stringify({ error: { code: 429, message: "quota", details: [{ retryDelay: "0.01s" }] } }), { status: 429 })
        : new Response(JSON.stringify({ candidates: [{ content: { role: "model", parts: [{ text: '{"ok":true}' }] } }] }), { status: 200 });
    }) as typeof fetch;
    const g = new LiveGemini("k", fake);
    g.minuteWaitMs = 5;
    const r = await g.generate({ model: "gemini-flash-latest", system: "s", contents: [{ role: "user", parts: [{ text: "hi" }] }], jsonSchema: { type: "object" }, tools: [{ name: "job_list", description: "d" }] });
    expect(r.text).toBe('{"ok":true}');
    expect(sent).toHaveLength(2);
    expect(sent[1]).toMatchObject({ systemInstruction: { parts: [{ text: "s" }] }, generationConfig: { responseMimeType: "application/json", responseJsonSchema: { type: "object" } }, tools: [{ functionDeclarations: [{ name: "job_list" }] }] });
  });

  it("moves to the next model when one hits its quota", async () => {
    const asked: string[] = [];
    const fake = (async (url: string) => {
      const model = String(url).match(/models\/([^:]+):/)![1];
      asked.push(model);
      return model === "busy-model"
        ? new Response(JSON.stringify({ error: { code: 429, message: "You exceeded your current quota", details: [{ retryDelay: "0.2s" }] } }), { status: 429 })
        : new Response(JSON.stringify({ candidates: [{ content: { role: "model", parts: [{ text: "ok" }] } }] }), { status: 200 });
    }) as typeof fetch;
    const g = new LiveGemini("k", fake);
    g.minuteWaitMs = 5;
    const r = await g.generate({ model: "busy-model", fallbackModels: ["spare-model"], contents: [{ role: "user", parts: [{ text: "hi" }] }] });
    expect(r.text).toBe("ok");
    expect(asked).toEqual(["busy-model", "busy-model", "spare-model"]); // waited once, then switched
  });

  it("keeps what it sends small: no email HTML, long text cut, older results trimmed", async () => {
    const { slim, compactOlder } = await import("../src/agent/llm.js");
    const thread = JSON.stringify({ messages: [{ subject: "S", body: "x".repeat(9000), html: "<div>".repeat(5000) }] }, null, 2);
    const s = slim(thread);
    expect(s).not.toContain("<div>");
    expect(s.length).toBeLessThan(2700);
    const contents: any[] = [
      { role: "user", parts: [{ text: "q" }] },
      { role: "user", parts: [{ functionResponse: { name: "a", response: { result: "y".repeat(5000) } } }] },
      { role: "user", parts: [{ functionResponse: { name: "b", response: { result: "z".repeat(5000) } } }] },
    ];
    compactOlder(contents);
    expect(contents[1].parts[0].functionResponse.response.result.length).toBeLessThan(1600);
    expect(contents[2].parts[0].functionResponse.response.result.length).toBe(5000); // the latest round stays whole
  });

  it("is off without a key", () => {
    const { hub } = testHub();
    expect(aiProvider(hub)).toBe("off");
  });
});

describe("send-off email on Gemini", () => {
  it("writes the email with Gemini, following the skill's step 6 from SKILL.md, and never calls Claude for it", async () => {
    const { SendoffWriter, skillStep6 } = await import("../src/agent/emailWriter.js");
    const t = geminiHub(() => JSON.stringify({ subject: "Your Reconstruction Estimate – 12 Elm St", body: "Hi Pat,\n\nAttached is the estimate.\n\nThanks," }));
    t.hub.cfg.anthropicApiKey = "";
    const job = { jobNumber: 4100, name: "Doe", address: "12 Elm St, Denver, CO", insurance: "claim", customer: { name: "Pat Doe", email: "" }, adjuster: { name: "", email: "" } } as any;
    const r = await new SendoffWriter(t.hub).writeEmail({ job, kind: "homeowner", total: 1234, attachments: ["Doe - Reconstruction Estimate.pdf"] });
    expect(r.subject).toContain("12 Elm St");
    const req = (t.hub.gemini as MockGemini).requests[0];
    expect(req.system).toContain("## 6.");
    expect(req.system).not.toContain("## Company details");
    expect(skillStep6(t.hub.cfg.skillDir)).toMatch(/^## 6\. Send-off email/);
  });

  it("picks the report photos with Gemini from the skill's contact sheets", async () => {
    const { SendoffWriter } = await import("../src/agent/emailWriter.js");
    const t = geminiHub(() => JSON.stringify({ photos: [{ number: 3, caption: "Wet drywall at the tub wall", room: "Bath" }, { number: 1, caption: "Overview" }, { number: 3, caption: "dup" }, { number: 99, caption: "no such photo" }] }));
    const dir = path.resolve("fixtures/photos");
    const photos = ["mock_1.jpg", "mock_2.jpg", "mock_3.jpg"].map((file) => ({ file, description: "", capturedAt: "" }));
    const picks = await new SendoffWriter(t.hub).pickPhotos({ jobNumber: 4100, address: "12 Elm St" } as any, photos, dir);
    expect(picks).toEqual([{ file: "mock_3.jpg", caption: "Wet drywall at the tub wall", room: "Bath" }, { file: "mock_1.jpg", caption: "Overview" }]);
    const parts = (t.hub.gemini as MockGemini).requests[0].contents[0].parts;
    expect(parts.some((x) => (x.inlineData as any)?.mimeType === "image/jpeg")).toBe(true);
  });

  it("without Gemini the photo picks fall back to the plain list (never the paid Claude API)", async () => {
    const { SendoffWriter } = await import("../src/agent/emailWriter.js");
    const t = testHub();
    t.hub.cfg.anthropicApiKey = "sk-ant-x";
    const picks = await new SendoffWriter(t.hub).pickPhotos({ jobNumber: 1 } as any, [{ file: "a.jpg", description: "Kitchen", capturedAt: "" }], "/tmp");
    expect(picks).toEqual([{ file: "a.jpg", caption: "Kitchen" }]);
  });
});

describe("selections setup on Gemini", () => {
  it("lists finishes from estimate.json and fills missing budgets from the skill's component costs", async () => {
    const { buildSelections } = await import("../src/agent/selections.js");
    const { loadSelections } = await import("../src/workflows/selections.js");
    const t = geminiHub((req, i) =>
      i === 0
        ? JSON.stringify({ categories: [{ name: "Laminate flooring", room: "Living", quantity: 220, unit: "SF", budgetPerUnit: 0, lookupWords: "laminate" }, { name: "Vanity", room: "Bath", quantity: 1, unit: "EA", budgetPerUnit: 400, basis: "estimate allowance" }] })
        : JSON.stringify({ categories: [{ name: "Laminate flooring", room: "Living", quantity: 220, unit: "SF", budgetPerUnit: 2.51, basis: "LAMSNAP" }, { name: "Vanity", room: "Bath", quantity: 1, unit: "EA", budgetPerUnit: 400, basis: "estimate allowance" }] }),
    );
    t.hub.cfg.anthropicApiKey = "";
    t.hub.jobs.upsert(4200, { name: "Doe" });
    const dir = t.hub.jobs.path(4200, "estimate");
    (await import("node:fs")).mkdirSync(dir, { recursive: true });
    (await import("node:fs")).copyFileSync(path.resolve("fixtures/estimate-sample.json"), path.join(dir, "estimate.json"));
    expect(await buildSelections(t.hub, 4200, () => {})).toBe(2);
    const reqs = (t.hub.gemini as MockGemini).requests;
    expect(reqs).toHaveLength(2);
    expect(reqs[1].contents[0].parts[0].text).toMatch(/--- laminate ---[\s\S]*LAMSNAP/);
    const cats = loadSelections(t.hub, 4200).categories;
    expect(cats.find((c) => c.name === "Laminate flooring")?.budgetTotal).toBe(552.2);
  });
});

describe("Ask follow-ups", () => {
  it("sends the earlier turns, so a reply to Claude's question makes sense", async () => {
    const t = geminiHub(() => "Done: drafted the follow-up to Sam.");
    await agentAsk(t.hub, "The second one", { history: [{ role: "user", text: "Draft a follow-up for Pine Ave" }, { role: "assistant", text: "Which one: the homeowner or the adjuster?" }] });
    const c = (t.hub.gemini as MockGemini).requests[0].contents;
    expect(c.map((x) => x.role)).toEqual(["user", "model", "user"]);
    expect(c[1].parts[0].text).toContain("homeowner or the adjuster");
    expect(c[2].parts[0].text).toBe("The second one");
  });
  it("puts the earlier turns in front of the message for Claude", async () => {
    const { withHistory } = await import("../src/agent/llm.js");
    expect(withHistory("yes", [{ role: "assistant", text: "Want me to draft it?" }])).toMatch(/Earlier in this conversation:[\s\S]*You: Want me to draft it\?[\s\S]*Hunter's reply now: yes/);
    expect(withHistory("hi")).toBe("hi");
  });
});

describe("which AI did the work", () => {
  it("reports the model that actually answered, including a fallback", async () => {
    let n = 0;
    const g = new LiveGemini("k", (async () => {
      n++;
      if (n === 1) return new Response(JSON.stringify({ error: { message: "high demand" } }), { status: 503 });
      if (n === 2) return new Response(JSON.stringify({ error: { message: "high demand" } }), { status: 503 });
      return new Response(JSON.stringify({ candidates: [{ content: { parts: [{ text: "hi" }] } }] }), { status: 200 });
    }) as any);
    (g as any).once = (LiveGemini.prototype as any).once; // real retry logic, but don't wait 3s
    const orig = setTimeout;
    (globalThis as any).setTimeout = (f: any) => orig(f, 0);
    try {
      const r = await g.generate({ model: "first-model", fallbackModels: ["backup-model"], contents: [{ role: "user", parts: [{ text: "x" }] }] });
      expect(r.model).toBe("backup-model");
    } finally {
      (globalThis as any).setTimeout = orig;
    }
  });
  it("Ask and complete record Gemini and its model", async () => {
    const t = geminiHub(() => "ok");
    const used = new Set<string>();
    await agentAsk(t.hub, "hi", { used });
    await complete(t.hub, { system: "s", prompt: "p", fast: true, used });
    expect([...used]).toEqual(["Gemini (gemini-flash-latest)", "Gemini (gemini-flash-lite-latest)"]);
  });
});
