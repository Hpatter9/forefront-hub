import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { HUB_ROOT } from "../../core/config.js";
import { buildMime, newMessageId } from "./mime.js";
import type { DraftInput, DraftRef, DraftStatus, Label, MailClient, Message, ThreadSummary } from "./types.js";

interface MockThread {
  id: string;
  labelIds: string[];
  messages: Message[];
}

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
    const t = this.loadThreads().find((x) => x.id === id);
    if (t) return { id, messages: t.messages.map((m) => ({ ...m, labelIds: t.labelIds })) };
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

  // ---- Mail tab: a small made-up inbox (fixtures/mail.json) plus whatever was sent or drafted here
  private threadsFile() {
    return path.join(this.stateDir, "mock-mail.json");
  }

  private loadThreads(): MockThread[] {
    if (existsSync(this.threadsFile())) return JSON.parse(readFileSync(this.threadsFile(), "utf8"));
    return JSON.parse(readFileSync(path.join(HUB_ROOT, "fixtures", "mail.json"), "utf8"));
  }

  private saveThreads(t: MockThread[]) {
    mkdirSync(this.stateDir, { recursive: true });
    writeFileSync(this.threadsFile(), JSON.stringify(t, null, 2));
  }

  fullAccess() {
    return true;
  }

  async listThreads(o: { label?: string; q?: string } = {}) {
    const words = (o.q ?? "").toLowerCase().split(/\s+/).filter((w) => w && !w.includes(":"));
    const drafts: MockThread[] = this.load().map((d) => ({
      id: d.ref.id,
      labelIds: d.sentAt ? ["SENT"] : ["DRAFT"],
      messages: [{ id: d.ref.id, from: this.from, to: d.input.to, cc: d.input.cc ?? [], date: d.sentAt ?? new Date().toISOString(), subject: d.input.subject, body: d.input.body, attachments: [] }],
    }));
    const all = [...this.loadThreads(), ...drafts]
      .filter((t) => !o.label || t.labelIds.includes(o.label))
      .filter((t) => words.every((w) => JSON.stringify(t.messages).toLowerCase().includes(w)))
      .map((t): ThreadSummary => {
        const last = t.messages.at(-1)!;
        return { id: t.id, subject: t.messages[0].subject, from: last.from, date: last.date, snippet: last.body.slice(0, 140), messageCount: t.messages.length, unread: t.labelIds.includes("UNREAD"), starred: t.labelIds.includes("STARRED"), labelIds: t.labelIds, hasAttachments: false };
      })
      .sort((a, b) => b.date.localeCompare(a.date));
    return { threads: all };
  }

  async labels(): Promise<Label[]> {
    const t = this.loadThreads();
    return [
      { id: "INBOX", name: "INBOX", type: "system", unread: t.filter((x) => x.labelIds.includes("INBOX") && x.labelIds.includes("UNREAD")).length },
      { id: "STARRED", name: "STARRED", type: "system" },
      { id: "SENT", name: "SENT", type: "system" },
      { id: "DRAFT", name: "DRAFT", type: "system" },
      { id: "SPAM", name: "SPAM", type: "system" },
      { id: "TRASH", name: "TRASH", type: "system" },
      // Two made-up labels of Hunter's own, so sorting by label can be tried without a real account.
      { id: "Label_1", name: "Adjusters", type: "user" },
      { id: "Label_2", name: "Receipts", type: "user" },
    ];
  }

  async send(d: DraftInput) {
    const messageId = newMessageId();
    const all = this.loadThreads();
    const msg: Message = { id: `sent-${Date.now().toString(36)}`, from: this.from, to: d.to, cc: d.cc ?? [], date: new Date().toISOString(), subject: d.subject, body: d.body, attachments: [] };
    const existing = d.threadId ? all.find((t) => t.id === d.threadId) : undefined;
    if (existing) {
      existing.messages.push(msg);
      if (!existing.labelIds.includes("SENT")) existing.labelIds.push("SENT");
    } else all.push({ id: `mock-thread-${Date.now().toString(36)}`, labelIds: ["SENT"], messages: [msg] });
    this.saveThreads(all);
    const outbox = path.join(this.stateDir, "outbox");
    mkdirSync(outbox, { recursive: true });
    writeFileSync(path.join(outbox, `${msg.id}.eml`), buildMime({ ...d, from: this.from, messageId }));
    return { id: msg.id, threadId: existing?.id ?? all.at(-1)!.id, messageId };
  }

  async modifyThread(id: string, change: { add?: string[]; remove?: string[]; trash?: boolean; untrash?: boolean }) {
    const all = this.loadThreads();
    const t = all.find((x) => x.id === id);
    if (!t) return;
    if (change.trash) t.labelIds = ["TRASH"];
    if (change.untrash) t.labelIds = [...t.labelIds.filter((l) => l !== "TRASH"), "INBOX"];
    t.labelIds = [...new Set([...t.labelIds.filter((l) => !(change.remove ?? []).includes(l)), ...(change.add ?? [])])];
    this.saveThreads(all);
  }
}
