import { writeFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";

const calls: any[] = [];
vi.mock("@anthropic-ai/claude-agent-sdk", async (orig) => ({
  ...(await orig<any>()),
  query: ({ prompt, options }: any) => {
    calls.push({ prompt, options });
    const n = calls.length;
    async function* gen() {
      yield { type: "system", subtype: "init", session_id: "sess-1" };
      yield { type: "stream_event", event: { type: "content_block_delta", delta: { type: "text_delta", text: "Look" } } };
      yield { type: "assistant", message: { content: [{ type: "tool_use", name: "Bash", input: { command: 'python3 render.py estimate.json --out x --only selections' } }] } };
      yield { type: "assistant", message: { content: [{ type: "text", text: n === 1 ? "Two questions first:\n1. Wet pad?" : "Rendered." }] } };
      yield { type: "result", subtype: "success", result: "" };
    }
    const g: any = gen();
    g.interrupt = async () => {};
    return g;
  },
}));

const { Studio, describeTool } = await import("../src/agent/studio.js");
const { makeGuard } = await import("../src/agent/guard.js");
const { testHub } = await import("./helpers.js");

describe("Estimator tab", () => {
  it("keeps one conversation per job and resumes Claude's session on follow-ups", async () => {
    const { hub } = testHub();
    hub.cfg.anthropicApiKey = "test";
    hub.jobs.upsert(3226, { name: "Augustine" });
    const events: any[] = [];
    const studio = new Studio(hub, (e) => events.push(e));
    await studio.send(3226, "New estimate please");
    expect(calls[0].options.resume).toBeUndefined();
    expect(calls[0].options.systemPrompt.append).toContain("Estimator tab");
    expect(calls[0].options.systemPrompt.append).toContain("#3226");
    await studio.send(3226, "Pad is dry");
    expect(calls[1].options.resume).toBe("sess-1");
    const v = studio.view(3226);
    expect(v.turns.map((t) => t.role)).toEqual(["user", "tool", "assistant", "user", "tool", "assistant"]);
    expect(v.turns[1].text).toBe("Running render.py (selections sheet)");
    expect(v.running).toBe(false);
    expect(events.some((e) => e.kind === "delta" && e.text === "Look")).toBe(true);
    expect(events.filter((e) => e.kind === "state").map((e) => e.running)).toEqual([true, false, true, false]);
    studio.reset(3226);
    expect(studio.view(3226).turns).toEqual([]);
    await studio.send(3226, "Start over");
    expect(calls[2].options.resume).toBeUndefined();
  });

  it("lists the job's documents by the names the skill writes", () => {
    const { hub } = testHub();
    hub.jobs.upsert(3226, { name: "Augustine" });
    writeFileSync(hub.jobs.path(3226, "estimate", "Augustine - Reconstruction Estimate.pdf"), "%PDF");
    writeFileSync(hub.jobs.path(3226, "estimate", "Augustine - Material Selection Approval.pdf"), "%PDF");
    writeFileSync(hub.jobs.path(3226, "files", "Carrier estimate.pdf"), "%PDF");
    writeFileSync(hub.jobs.path(3226, "sketch", "Augustine.ESX"), "x");
    const f = new Studio(hub, () => {}).files(3226);
    const have = Object.fromEntries(f.docs.map((d) => [d.key, d.file?.path ?? null]));
    expect(have).toEqual({ estimate: "estimate/Augustine - Reconstruction Estimate.pdf", agreement: null, xactimate: null, selections: "estimate/Augustine - Material Selection Approval.pdf", photos: null, subs: null });
    expect(f.otherPdfs.map((x) => x.path)).toEqual(["files/Carrier estimate.pdf"]);
    expect(f.inputs.sketches[0].name).toBe("Augustine.ESX");
  });

  it("doesn't ask to overwrite the estimate when only the selections sheet is rendered", async () => {
    const { hub } = testHub(false);
    hub.jobs.upsert(3226, { name: "Augustine" });
    const dir = hub.jobs.path(3226, "estimate");
    writeFileSync(`${dir}/Augustine - Reconstruction Estimate.pdf`, "%PDF");
    const guard = makeGuard(hub);
    const opts = { signal: new AbortController().signal, suggestions: [] } as any;
    expect((await guard("Bash", { command: `python3 render.py estimate.json --out "${dir}" --only selections` }, opts))!.behavior).toBe("allow");
    expect((await guard("Bash", { command: `python3 render.py estimate.json --out "${dir}"` }, opts))!.behavior).toBe("deny");
    expect(describeTool("mcp__hub__photo_report", {})).toBe("photo report");
  });
});
