import { google } from "googleapis";
import { describe, expect, it } from "vitest";
import { throttled } from "../src/connectors/gmail/google.js";

describe("Gmail pacing wrapper", () => {
  it("wraps the real googleapis client without breaking its read-only resources", async () => {
    const gmail = throttled(google.gmail({ version: "v1" }));
    // This threw "'get' on proxy: property 'users' is a read-only and non-configurable..." before.
    expect(typeof gmail.users.threads.list).toBe("function");
    expect(typeof gmail.users.messages.attachments.get).toBe("function");
    expect("users" in gmail).toBe(true);
  });
});
