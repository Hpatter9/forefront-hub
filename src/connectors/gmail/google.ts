import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { google, type gmail_v1 } from "googleapis";
import { GoogleAuth, openBrowser, SCOPES, type GoogleOpts } from "../google/auth.js";
import { buildMime, htmlToText, newMessageId } from "./mime.js";
import type { DraftInput, DraftRef, DraftStatus, Label, MailClient, Message, ThreadSummary } from "./types.js";

// modify = read, label (archive / mark read / star / trash) and send; compose = drafts. Claude and the workflows only
// create drafts; sending happens from the Gmail tab's Send button after Hunter confirms, and auto-filing forwards
// to Forefront's own office+<job#> addresses.
export { openBrowser, type GoogleOpts };

export class GoogleGmail implements MailClient {
  readonly kind = "google" as const;
  private api?: gmail_v1.Gmail;
  private signature?: { html: string; from: string };

  constructor(private opts: GoogleOpts) {
    this.auth = new GoogleAuth(opts);
  }

  private auth: GoogleAuth;

  /** One-time: opens Google's consent page (Gmail + Calendar) and saves the token. */
  async login(): Promise<void> {
    await this.auth.login();
  }

  /**
   * Every Gmail request goes through a pacer and a retry: Google allows a limited number of quota units per user
   * per minute (and per second), and Keystone's background checks plus the Gmail tab can add up. Calls wait their
   * turn instead of failing, and a "slow down" answer is retried after a pause.
   */
  private gmail(): gmail_v1.Gmail {
    this.api ??= throttled(google.gmail({ version: "v1", auth: this.auth.client() }));
    return this.api;
  }

  private summaries = new Map<string, { historyId: string; s: ThreadSummary }>();
  private full = new Map<string, { historyId: string; t: { id: string; messages: Message[] } }>();

  /** Hunter's Gmail signature and display name, so drafts look exactly like the ones he types. */
  private async sendAs() {
    if (this.signature) return this.signature;
    const { data } = await this.gmail().users.settings.sendAs.list({ userId: "me" });
    const me = data.sendAs?.find((s) => s.sendAsEmail?.toLowerCase() === this.opts.address.toLowerCase()) ?? data.sendAs?.find((s) => s.isDefault);
    const email = me?.sendAsEmail ?? this.opts.address;
    this.signature = { html: me?.signature ?? "", from: me?.displayName ? `${me.displayName} <${email}>` : email };
    return this.signature;
  }

  async createDraft(d: DraftInput): Promise<DraftRef> {
    for (const f of d.attachments) if (!existsSync(f)) throw new Error(`Attachment not found: ${f}`);
    const { html, from } = await this.sendAs();
    const messageId = newMessageId();
    const raw = Buffer.from(buildMime({ ...d, from, messageId, signatureHtml: html })).toString("base64url");
    const { data } = await this.gmail().users.drafts.create({
      userId: "me",
      requestBody: { message: { raw, threadId: d.threadId } },
    });
    // Label just this draft message (not the whole thread), so it shows under the label in Gmail too.
    if (d.labels?.length && data.message?.id) {
      try {
        const ids = await Promise.all(d.labels.map((l) => this.ensureLabel(l)));
        await this.gmail().users.messages.modify({ userId: "me", id: data.message.id, requestBody: { addLabelIds: ids } });
      } catch {
        // A label is a nice-to-have; the draft is made either way.
      }
    }
    return { id: data.id!, messageId, threadId: data.message?.threadId ?? undefined };
  }

  async sendDraft(draftId: string) {
    await this.gmail().users.drafts.send({ userId: "me", requestBody: { id: draftId } });
  }

  /** keepMessageId: the draft's Message-ID header, kept so Keystone still recognizes it once it's sent. */
  async updateDraft(draftId: string, d: DraftInput, keepMessageId?: string) {
    for (const f of d.attachments) if (!existsSync(f)) throw new Error(`Attachment not found: ${f}`);
    const { html, from } = await this.sendAs();
    const raw = Buffer.from(buildMime({ ...d, from, messageId: keepMessageId || newMessageId(), signatureHtml: html })).toString("base64url");
    const { data } = await this.gmail().users.drafts.update({ userId: "me", id: draftId, requestBody: { id: draftId, message: { raw, threadId: d.threadId } } });
    if (d.labels?.length && data.message?.id) {
      try {
        const ids = await Promise.all(d.labels.map((l) => this.ensureLabel(l)));
        await this.gmail().users.messages.modify({ userId: "me", id: data.message.id, requestBody: { addLabelIds: ids } });
      } catch {
        // the label is a nice-to-have
      }
    }
    return { messageId: data.message?.id ?? "" };
  }

  async deleteDraft(draftId: string) {
    await this.gmail().users.drafts.delete({ userId: "me", id: draftId });
  }

  async draftIdFor(messageId: string): Promise<string | null> {
    let pageToken: string | undefined;
    for (let i = 0; i < 5; i++) {
      const { data } = await this.gmail().users.drafts.list({ userId: "me", maxResults: 500, pageToken });
      const hit = data.drafts?.find((d) => d.message?.id === messageId);
      if (hit?.id) return hit.id;
      if (!data.nextPageToken) return null;
      pageToken = data.nextPageToken;
    }
    return null;
  }

  async draftStatus(ref: DraftRef): Promise<DraftStatus> {
    try {
      await this.gmail().users.drafts.get({ userId: "me", id: ref.id, format: "minimal" });
      return { state: "draft" };
    } catch (e: any) {
      if (e?.code !== 404 && e?.status !== 404) throw e;
    }
    // The draft is gone: either sent (find it in Sent by the Message-ID we set) or deleted.
    const { data } = await this.gmail().users.messages.list({ userId: "me", q: `in:sent rfc822msgid:${ref.messageId.replace(/[<>]/g, "")}` });
    const id = data.messages?.[0]?.id;
    if (!id) return { state: "gone" };
    const msg = await this.gmail().users.messages.get({ userId: "me", id, format: "minimal" });
    return { state: "sent", sentAt: new Date(Number(msg.data.internalDate)).toISOString() };
  }

  fullAccess(): boolean {
    return this.auth.hasScope(SCOPES.gmailModify);
  }

  async listThreads(o: { label?: string; q?: string; pageToken?: string; max?: number } = {}) {
    const { data } = await this.gmail().users.threads.list({
      userId: "me",
      labelIds: o.label ? [o.label] : undefined,
      q: o.q || undefined,
      pageToken: o.pageToken,
      maxResults: o.max ?? 30,
    });
    // A thread whose historyId hasn't moved hasn't changed: reuse the summary instead of fetching it again.
    const threads = await Promise.all(
      (data.threads ?? []).map(async (t) => {
        const hit = this.summaries.get(t.id!);
        if (hit && hit.historyId === t.historyId) return hit.s;
        const s = await this.summary(t.id!);
        this.summaries.set(t.id!, { historyId: t.historyId ?? "", s: { ...s, historyId: t.historyId ?? undefined } });
        return { ...s, historyId: t.historyId ?? undefined };
      }),
    );
    return { threads, nextPageToken: data.nextPageToken ?? undefined };
  }

  private async summary(id: string): Promise<ThreadSummary> {
    const th = await this.gmail().users.threads.get({ userId: "me", id, format: "metadata", metadataHeaders: ["Subject", "From", "Date"] });
    const msgs = th.data.messages ?? [];
    const first = msgs[0];
    const last = msgs.at(-1);
    const h = (m: gmail_v1.Schema$Message | undefined, n: string) => m?.payload?.headers?.find((x) => x.name === n)?.value ?? "";
    const labels = new Set(msgs.flatMap((m) => m.labelIds ?? []));
    return {
      id,
      subject: h(first, "Subject"),
      from: h(last, "From"),
      date: last?.internalDate ? new Date(Number(last.internalDate)).toISOString() : h(last, "Date"),
      snippet: last?.snippet ?? "",
      messageCount: msgs.length,
      unread: labels.has("UNREAD"),
      starred: labels.has("STARRED"),
      labelIds: [...labels],
      hasAttachments: msgs.some((m) => (m.payload?.parts ?? []).some((p) => !!p.filename)),
    };
  }

  async labels(): Promise<Label[]> {
    const { data } = await this.gmail().users.labels.list({ userId: "me" });
    const wanted = (data.labels ?? []).filter((l) => l.type === "user" || ["INBOX", "STARRED", "SENT", "DRAFT", "IMPORTANT", "SPAM", "TRASH"].includes(l.id!));
    const inbox = await this.gmail().users.labels.get({ userId: "me", id: "INBOX" });
    return wanted.map((l) => ({ id: l.id!, name: l.name!, type: l.type === "user" ? "user" : "system", unread: l.id === "INBOX" ? inbox.data.threadsUnread ?? 0 : undefined }));
  }

  async send(d: DraftInput) {
    for (const f of d.attachments) if (!existsSync(f)) throw new Error(`Attachment not found: ${f}`);
    const { html, from } = await this.sendAs();
    const messageId = newMessageId();
    const raw = Buffer.from(buildMime({ ...d, from, messageId, signatureHtml: html })).toString("base64url");
    const { data } = await this.gmail().users.messages.send({ userId: "me", requestBody: { raw, threadId: d.threadId } });
    return { id: data.id!, threadId: data.threadId!, messageId };
  }

  async modifyThread(id: string, change: { add?: string[]; remove?: string[]; trash?: boolean; untrash?: boolean }) {
    if (change.trash) {
      await this.gmail().users.threads.trash({ userId: "me", id });
      return;
    }
    if (change.untrash) {
      await this.gmail().users.threads.untrash({ userId: "me", id });
      if (!change.add?.length && !change.remove?.length) return;
    }
    await this.gmail().users.threads.modify({ userId: "me", id, requestBody: { addLabelIds: change.add ?? [], removeLabelIds: change.remove ?? [] } });
  }

  async ensureLabel(name: string): Promise<string> {
    const { data } = await this.gmail().users.labels.list({ userId: "me" });
    const hit = data.labels?.find((l) => l.name === name);
    if (hit?.id) return hit.id;
    const made = await this.gmail().users.labels.create({ userId: "me", requestBody: { name, labelListVisibility: "labelShow", messageListVisibility: "show" } });
    return made.data.id!;
  }

  async attachment(messageId: string, attachmentId: string): Promise<Buffer> {
    const res = await this.gmail().users.messages.attachments.get({ userId: "me", messageId, id: attachmentId });
    return Buffer.from(res.data.data!, "base64url");
  }

  async search(q: string, max = 15): Promise<ThreadSummary[]> {
    const { data } = await this.gmail().users.threads.list({ userId: "me", q, maxResults: max });
    const out: ThreadSummary[] = [];
    for (const t of data.threads ?? []) {
      const th = await this.gmail().users.threads.get({ userId: "me", id: t.id!, format: "metadata", metadataHeaders: ["Subject", "From", "Date"] });
      const last = th.data.messages?.at(-1);
      const h = (n: string) => last?.payload?.headers?.find((x) => x.name === n)?.value ?? "";
      out.push({ id: t.id!, subject: h("Subject"), from: h("From"), date: h("Date"), snippet: last?.snippet ?? "", messageCount: th.data.messages?.length ?? 0 });
    }
    return out;
  }

  async getThread(id: string, historyId?: string): Promise<{ id: string; messages: Message[] }> {
    const hit = this.full.get(id);
    if (hit && historyId && hit.historyId === historyId) return hit.t;
    const t = await this.fetchThread(id);
    if (historyId) this.full.set(id, { historyId, t });
    return t;
  }

  private async fetchThread(id: string): Promise<{ id: string; messages: Message[] }> {
    const { data } = await this.gmail().users.threads.get({ userId: "me", id, format: "full" });
    return { id, messages: (data.messages ?? []).map(toMessage) };
  }

  async saveAttachments(messageId: string, destDir: string, filter?: RegExp): Promise<string[]> {
    const { data } = await this.gmail().users.messages.get({ userId: "me", id: messageId, format: "full" });
    const saved: string[] = [];
    mkdirSync(destDir, { recursive: true });
    for (const a of toMessage(data).attachments) {
      if (filter && !filter.test(a.filename)) continue;
      const res = await this.gmail().users.messages.attachments.get({ userId: "me", messageId, id: a.id });
      const file = path.join(destDir, a.filename);
      writeFileSync(file, Buffer.from(res.data.data!, "base64url"));
      saved.push(file);
    }
    return saved;
  }
}

function toMessage(m: gmail_v1.Schema$Message): Message {
  const headers = m.payload?.headers ?? [];
  const h = (n: string) => headers.find((x) => x.name?.toLowerCase() === n.toLowerCase())?.value ?? "";
  const parts: gmail_v1.Schema$MessagePart[] = [];
  const walk = (p?: gmail_v1.Schema$MessagePart) => {
    if (!p) return;
    parts.push(p);
    p.parts?.forEach(walk);
  };
  walk(m.payload);
  const decode = (p?: gmail_v1.Schema$MessagePart) => (p?.body?.data ? Buffer.from(p.body.data, "base64url").toString("utf8") : "");
  const text = parts.find((p) => p.mimeType === "text/plain" && !p.filename);
  const html = parts.find((p) => p.mimeType === "text/html" && !p.filename);
  return {
    id: m.id!,
    from: h("From"),
    to: h("To").split(",").map((s) => s.trim()).filter(Boolean),
    cc: h("Cc").split(",").map((s) => s.trim()).filter(Boolean),
    bcc: h("Bcc").split(",").map((s) => s.trim()).filter(Boolean),
    date: m.internalDate ? new Date(Number(m.internalDate)).toISOString() : h("Date"),
    subject: h("Subject"),
    body: text ? decode(text) : htmlToText(decode(html)),
    html: html ? decode(html) : undefined,
    messageIdHeader: h("Message-ID") || h("Message-Id") || undefined,
    labelIds: m.labelIds ?? [],
    attachments: parts
      .filter((p) => p.filename && p.body?.attachmentId)
      .map((p) => ({ id: p.body!.attachmentId!, filename: p.filename!, mimeType: p.mimeType ?? "", size: p.body?.size ?? undefined })),
  };
}


// ---------------------------------------------------------------- pacing Gmail requests

/** Approximate Gmail quota units per method (Google's published costs). */
function unitsFor(path: string): number {
  if (/send$/.test(path)) return 100;
  if (/attachments\.get$/.test(path)) return 5;
  if (/threads\.(get|modify|trash)$/.test(path)) return 10;
  if (/messages\.get$/.test(path)) return 5;
  if (/drafts\.(create|get)$/.test(path)) return 10;
  if (/\.list$/.test(path)) return 5;
  return 5;
}

const spent: { at: number; units: number }[] = [];
const PER_MINUTE = 9000; // well under Google's per-user minute limit
const PER_SECOND = 200;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function budget(units: number) {
  for (;;) {
    const now = Date.now();
    while (spent.length && now - spent[0].at > 60_000) spent.shift();
    const minute = spent.reduce((t, x) => t + x.units, 0);
    const second = spent.filter((x) => now - x.at < 1000).reduce((t, x) => t + x.units, 0);
    if (minute + units <= PER_MINUTE && second + units <= PER_SECOND) {
      spent.push({ at: now, units });
      return;
    }
    await sleep(second + units > PER_SECOND ? 250 : 2000);
  }
}

function isRateLimit(e: any) {
  const status = e?.code ?? e?.status ?? e?.response?.status;
  const msg = String(e?.message ?? "");
  return status === 429 || (status === 403 && /rate ?limit|quota/i.test(msg)) || /quota exceeded|rate limit/i.test(msg);
}

async function paced<T>(path: string, f: () => Promise<T>): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    await budget(unitsFor(path));
    try {
      return await f();
    } catch (e) {
      if (!isRateLimit(e) || attempt >= 5) throw e;
      await sleep(Math.min(60_000, 3000 * 2 ** attempt) + Math.random() * 1000);
    }
  }
}

/** Wraps the Gmail client so every method call (users.threads.get, ...) is paced and retried. */
export function throttled<T extends object>(target: T, path = ""): T {
  // The proxy wraps an empty object, not googleapis' own: its resources (gmail.users, ...) are read-only,
  // non-configurable properties, and a proxy may not hand back a wrapped copy of those from its target.
  return new Proxy({} as T, {
    get(_shell, key) {
      const v = Reflect.get(target, key);
      const p = path ? `${path}.${String(key)}` : String(key);
      if (typeof v === "function") return (...args: unknown[]) => paced(p, () => v.apply(target, args));
      if (v && typeof v === "object" && /^(users|threads|messages|drafts|labels|attachments|settings|sendAs|history)$/.test(String(key))) return throttled(v as object, p);
      return v;
    },
    has: (_shell, key) => Reflect.has(target, key),
  });
}
