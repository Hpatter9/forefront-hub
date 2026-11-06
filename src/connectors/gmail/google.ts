import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import http from "node:http";
import type { AddressInfo } from "node:net";
import path from "node:path";
import { google, type gmail_v1 } from "googleapis";
import { buildMime, htmlToText, newMessageId } from "./mime.js";
import type { DraftInput, DraftRef, DraftStatus, Label, MailClient, Message, ThreadSummary } from "./types.js";

// modify = read, label (archive / mark read / star / trash) and send; compose = drafts. Claude and the workflows only
// create drafts; sending happens only from the Mail tab's Send button after Hunter confirms.
const SCOPES = ["https://www.googleapis.com/auth/gmail.modify", "https://www.googleapis.com/auth/gmail.compose"];
const MODIFY = "https://www.googleapis.com/auth/gmail.modify";

export interface GoogleOpts {
  clientId: string;
  clientSecret: string;
  tokenFile: string;
  address: string;
}

export class GoogleGmail implements MailClient {
  readonly kind = "google" as const;
  private api?: gmail_v1.Gmail;
  private signature?: { html: string; from: string };

  constructor(private opts: GoogleOpts) {}

  private client(redirectUri?: string) {
    return new google.auth.OAuth2(this.opts.clientId, this.opts.clientSecret, redirectUri);
  }

  /** One-time: opens Google's consent page in your browser and saves the token to auth/google-token.json. */
  async login(): Promise<void> {
    const server = http.createServer();
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    const redirect = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const oauth = this.client(redirect);
    const url = oauth.generateAuthUrl({ access_type: "offline", prompt: "consent", scope: SCOPES, login_hint: this.opts.address });
    const code = await new Promise<string>((resolve, reject) => {
      server.on("request", (req, res) => {
        const u = new URL(req.url ?? "/", redirect);
        const c = u.searchParams.get("code");
        res.end(c ? "Gmail is connected to the Forefront hub. You can close this tab." : `Error: ${u.searchParams.get("error")}`);
        c ? resolve(c) : reject(new Error(u.searchParams.get("error") ?? "no code"));
      });
      console.log(`Opening Google sign-in. If it doesn't open, paste this into your browser:\n${url}\n`);
      openBrowser(url);
    });
    server.close();
    const { tokens } = await oauth.getToken(code);
    mkdirSync(path.dirname(this.opts.tokenFile), { recursive: true });
    writeFileSync(this.opts.tokenFile, JSON.stringify(tokens, null, 2));
    console.log(`Saved Gmail token to ${this.opts.tokenFile}`);
  }

  private gmail(): gmail_v1.Gmail {
    if (this.api) return this.api;
    if (!existsSync(this.opts.tokenFile)) throw new Error("Gmail isn't connected yet. Run: npm run hub -- gmail login");
    const oauth = this.client();
    oauth.setCredentials(JSON.parse(readFileSync(this.opts.tokenFile, "utf8")));
    oauth.on("tokens", (t) => {
      const old = JSON.parse(readFileSync(this.opts.tokenFile, "utf8"));
      writeFileSync(this.opts.tokenFile, JSON.stringify({ ...old, ...t }, null, 2));
    });
    this.api = google.gmail({ version: "v1", auth: oauth });
    return this.api;
  }

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
    return { id: data.id!, messageId, threadId: data.message?.threadId ?? undefined };
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
    if (!existsSync(this.opts.tokenFile)) return false;
    const scope: string = JSON.parse(readFileSync(this.opts.tokenFile, "utf8")).scope ?? "";
    return scope.split(/\s+/).includes(MODIFY);
  }

  async listThreads(o: { label?: string; q?: string; pageToken?: string; max?: number } = {}) {
    const { data } = await this.gmail().users.threads.list({
      userId: "me",
      labelIds: o.label ? [o.label] : undefined,
      q: o.q || undefined,
      pageToken: o.pageToken,
      maxResults: o.max ?? 30,
    });
    const threads = await Promise.all((data.threads ?? []).map((t) => this.summary(t.id!)));
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

  async modifyThread(id: string, change: { add?: string[]; remove?: string[]; trash?: boolean }) {
    if (change.trash) {
      await this.gmail().users.threads.trash({ userId: "me", id });
      return;
    }
    await this.gmail().users.threads.modify({ userId: "me", id, requestBody: { addLabelIds: change.add ?? [], removeLabelIds: change.remove ?? [] } });
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

  async getThread(id: string): Promise<{ id: string; messages: Message[] }> {
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

export function openBrowser(url: string) {
  const cmd = process.platform === "win32" ? ["cmd", ["/c", "start", '""', `"${url}"`]] : process.platform === "darwin" ? ["open", [url]] : ["xdg-open", [url]];
  try {
    spawn(cmd[0] as string, cmd[1] as string[], { stdio: "ignore", detached: true, shell: process.platform === "win32" }).unref();
  } catch {
    /* the URL is printed too */
  }
}
