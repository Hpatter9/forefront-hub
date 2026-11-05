import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { buildMime, newMessageId } from "./mime.js";
import type { DraftInput, DraftRef, DraftStatus, MailClient, Message, ThreadSummary } from "./types.js";

interface Stored {
  ref: DraftRef;
  input: DraftInput;
  sentAt?: string;
  eml: string;
}

/**
 * Gmail on disk: each draft is written as an .eml in <stateDir>/outbox so you can open it and check it.
 * `markSent` (or `hub mock send <draft>`) simulates you pressing Send.
 */
export class MockGmail implements MailClient {
  readonly kind = "mock" as const;
  private file: string;
  constructor(private stateDir: string, private from = "Hunter Patterson <hunter@forefrontteam.com>") {
    this.file = path.join(stateDir, "mock-gmail.json");
  }

  private load(): Stored[] {
    return existsSync(this.file) ? JSON.parse(readFileSync(this.file, "utf8")) : [];
  }

  private save(all: Stored[]) {
    mkdirSync(this.stateDir, { recursive: true });
    writeFileSync(this.file, JSON.stringify(all, null, 2));
  }

  drafts(): Stored[] {
    return this.load();
  }

  async createDraft(d: DraftInput): Promise<DraftRef> {
    for (const f of d.attachments) if (!existsSync(f)) throw new Error(`Attachment not found: ${f}`);
    const ref = { id: `mock-draft-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`, messageId: newMessageId() };
    const outbox = path.join(this.stateDir, "outbox");
    mkdirSync(outbox, { recursive: true });
    const eml = path.join(outbox, `${ref.id}.eml`);
    writeFileSync(eml, buildMime({ ...d, from: this.from, messageId: ref.messageId, signatureHtml: "Hunter Patterson<br>Estimator" }));
    this.save([...this.load(), { ref, input: d, eml }]);
    return ref;
  }

  markSent(draftId: string, at = new Date().toISOString()) {
    const all = this.load();
    const d = all.find((x) => x.ref.id === draftId);
    if (!d) throw new Error(`No mock draft ${draftId}`);
    d.sentAt = at;
    this.save(all);
  }

  async draftStatus(ref: DraftRef): Promise<DraftStatus> {
    const d = this.load().find((x) => x.ref.id === ref.id);
    if (!d) return { state: "gone" };
    return d.sentAt ? { state: "sent", sentAt: d.sentAt } : { state: "draft" };
  }

  async search(q: string): Promise<ThreadSummary[]> {
    const words = q.toLowerCase().split(/\s+/).filter((w) => w && !w.includes(":"));
    return this.load()
      .filter((d) => d.sentAt && words.every((w) => `${d.input.subject} ${d.input.body} ${d.input.to}`.toLowerCase().includes(w)))
      .map((d) => ({ id: d.ref.id, subject: d.input.subject, from: this.from, date: d.sentAt!, snippet: d.input.body.slice(0, 120), messageCount: 1 }));
  }

  async getThread(id: string): Promise<{ id: string; messages: Message[] }> {
    const d = this.load().find((x) => x.ref.id === id);
    if (!d) throw new Error(`No mock thread ${id}`);
    return {
      id,
      messages: [{ id, from: this.from, to: d.input.to, cc: d.input.cc ?? [], date: d.sentAt ?? "", subject: d.input.subject, body: d.input.body, attachments: [] }],
    };
  }

  async saveAttachments(): Promise<string[]> {
    return [];
  }
}
