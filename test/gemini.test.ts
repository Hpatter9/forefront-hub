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
    expect(loadConfig({ HUB_MODE: "mock", ANTHROPIC_API_KEY: "a" }).ai.provider).toBe("claude");
    expect(loadConfig({ HUB_MODE: "mock", ANTHROPIC_API_KEY: "a", GEMINI_API_KEY: "g", HUB_AI: "claude" }).ai.provider).toBe("claude");
    expect(loadConfig({ HUB_MODE: "mock", HUB_AI: "gemini" }).ai.provider).toBe("off");
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
