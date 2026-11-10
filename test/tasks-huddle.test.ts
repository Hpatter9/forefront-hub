import { describe, expect, it } from "vitest";
import { ensureTaskLines, labelTasks } from "../src/workflows/briefTasks.js";
import { huddleAdd, huddleClearDone, huddleList, huddleRemove, huddleUpdate } from "../src/workflows/huddle.js";
import { testHub } from "./helpers.js";

describe("Google Tasks in the brief", () => {
  const tasks = [{ listId: "L", id: "a1", title: "Order tile samples" }, { listId: "L", id: "b2", title: "Send Xactimate to adjuster #9001" }, { listId: "L", id: "c3", title: "Call the supplier" }] as any[];
  const { map, tagOf } = labelTasks(tasks);

  it("tags each task and keeps which real task a tag is", () => {
    expect(tagOf(tasks[1])).toBe("T2");
    expect(map.T2).toEqual({ listId: "L", id: "b2", title: "Send Xactimate to adjuster #9001" });
  });

  it("keeps the AI's tags, tags a task it mentioned without one, adds any it left out, and drops made-up tags", () => {
    const text = "**Do in this order**\n1. #9001 Sample: Send Xactimate to adjuster #9001 {go:9001:job}\n2. Order tile samples {task:T1}\n3. Something else {task:T9}";
    const out = ensureTaskLines(text, map);
    expect(out).toContain("1. #9001 Sample: Send Xactimate to adjuster #9001 {go:9001:job} {task:T2}");
    expect(out).toContain("2. Order tile samples {task:T1}");
    expect(out).toContain("3. Something else\n");
    expect(out).toMatch(/\*\*My tasks\*\*[^\n]*\n- Call the supplier \{task:T3\}$/);
    expect(out.match(/\{task:T1\}/g)).toHaveLength(1);
  });

  it("adds left-out tasks under an existing My tasks heading", () => {
    const out = ensureTaskLines("**My tasks**\n- Order tile samples {task:T1}\n\n**On the calendar:** none", map);
    expect(out).toBe("**My tasks**\n- Order tile samples {task:T1}\n- Send Xactimate to adjuster #9001 {task:T2}\n- Call the supplier {task:T3}\n\n**On the calendar:** none");
  });
});

describe("huddle list", () => {
  it("adds, ticks off, clears what's been brought up, and removes", () => {
    const { hub } = testHub();
    const a = huddleAdd(hub, "Ask about the dumpster on #9001");
    const b = huddleAdd(hub, "PTO next Friday");
    expect(a.jobNumber).toBe(9001);
    expect(huddleList(hub).map((x) => x.text)).toEqual(["Ask about the dumpster on #9001", "PTO next Friday"]);
    expect(huddleUpdate(hub, a.id, { done: true }).doneAt).toBeTruthy();
    expect(huddleClearDone(hub)).toBe(1);
    huddleRemove(hub, b.id);
    expect(huddleList(hub)).toEqual([]);
    expect(() => huddleAdd(hub, "  ")).toThrow();
  });
});
