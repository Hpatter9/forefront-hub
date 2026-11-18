import { describe, expect, it } from "vitest";
import { compactOlder, limitsFor, slim } from "../src/agent/llm.js";
import type { Message } from "../src/connectors/gmail/types.js";
import { MESSAGE_PART, threadForAi } from "../src/workflows/conversation.js";

const msg = (id: string, from: string, date: string, body: string): Message => ({ id, from, to: ["x@example.com"], cc: [], date, subject: "Re: 0000-Supplement Response", body, attachments: [] });

// An adjuster answering inline, inside the quoted email, the way supplement responses usually come back.
const hunter = `Hi Alex,\n\n${Array.from({ length: 40 }, (_, i) => `Item ${i + 1}: please review line ${i + 1} of the supplement, with the reason it's needed and the photo that shows it.`).join("\n")}\n\nThanks,`;
const inline = `Good afternoon,\n\nThank you so much for your email. I have provided responses here for you below which are highlighted.\n\nFrom: Hunter\nSent: Monday\n\n${Array.from({ length: 40 }, (_, i) => `Item ${i + 1}: please review line ${i + 1} of the supplement.\n  RESPONSE ${i + 1}: ${i === 39 ? "Hallway and landing carpet added at the CL price; Xact pricing stays for the rest." : "Agreed, added."}`).join("\n")}`;

describe("reading an email thread for the AI", () => {
  it("keeps the newest reply whole, inline answers in the quoted part included, through the AI's size limits", () => {
    const th = { id: "t1", messages: [msg("m1", "Hunter", "2026-11-16", hunter), msg("m2", "Alex", "2026-11-17", inline)] };
    const out = threadForAi(th);
    expect(out.messages![1].body).toBe(inline);
    expect(out.messages![1]).not.toHaveProperty("more");
    const { max, str } = limitsFor("gmail_read_thread");
    const sent = slim(JSON.stringify(out), max, str);
    expect(sent).toContain("RESPONSE 40: Hallway and landing carpet added at the CL price");
    expect(sent).not.toContain("(cut");
  });

  it("gives a very long message in parts and says how to read the rest", () => {
    const long = "x".repeat(MESSAGE_PART + 5_000) + " THE END";
    const th = { id: "t1", messages: [msg("m1", "Alex", "2026-11-17", long)] };
    const first = threadForAi(th).messages![0];
    expect(first.body).toHaveLength(MESSAGE_PART);
    expect(first.more).toMatch(/messageId "m1" and offset 30000/);
    const rest = threadForAi(th, { messageId: "m1", offset: MESSAGE_PART }).message!;
    expect(rest.body.endsWith("THE END")).toBe(true);
    expect(rest).not.toHaveProperty("more");
  });

  it("doesn't trim an email thread on later steps (the reply is written from it)", () => {
    const big = "y".repeat(20_000);
    const contents: any[] = [
      { role: "user", parts: [{ functionResponse: { name: "gmail_read_thread", response: { result: big } } }] },
      { role: "user", parts: [{ functionResponse: { name: "job_timeline", response: { result: big } } }] },
      { role: "user", parts: [{ functionResponse: { name: "job_get", response: { result: "{}" } } }] },
    ];
    compactOlder(contents);
    expect(contents[0].parts[0].functionResponse.response.result).toHaveLength(20_000);
    expect(contents[1].parts[0].functionResponse.response.result.length).toBeLessThan(2_000);
  });
});
