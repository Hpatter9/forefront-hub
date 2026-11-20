import { existsSync, mkdirSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { Hub } from "../hub.js";
import { htmlToText } from "../connectors/gmail/mime.js";
import { GENERATED_LABEL, generatedDrafts } from "./generated.js";

/**
 * The compose box's draft, kept in Gmail the way Gmail keeps its own: the first save makes the draft, every later
 * save (the page saves a moment after typing stops, and when the box closes) updates that same draft. Nothing here
 * sends; sending is a separate step that asks first.
 */
export interface ComposeBody {
  /** Gmail's draft id, once this box has saved. */
  draftId?: string;
  /** For a draft opened from a conversation: the id of its message, to find the draft by. */
  draftMsgId?: string;
  /** The draft's Message-ID header, kept the same across saves. */
  header?: string;
  threadId?: string;
  to?: string; cc?: string; bcc?: string; subject?: string;
  /** Plain text and its formatted twin. */
  body?: string; html?: string; quoteHtml?: string;
  inReplyTo?: string; references?: string;
  /** The draft sits in a conversation with real messages (it stays there even if the one it answers has no Message-ID). */
  inThread?: boolean;
  jobNumber?: number;
  /** Files added in the box: from a job's folder, or picked from the PC (uploaded first). */
  attachments?: ({ job: number; path: string } | { upload: string } | { msg: string; id: string; name: string })[];
  /** Names of the attachments an existing draft already had that are staying on. */
  keep?: string[];
}
export interface ComposeSaved { draftId: string; messageId: string; header: string; threadId?: string }

const split = (s: unknown) => String(s ?? "").split(/[,;]/).map((x) => x.trim()).filter(Boolean);
const safeName = (n: string) => path.basename(n).replace(/[<>:"/\\|?*\x00-\x1f]/g, "_").slice(0, 180) || "file";
const inside = (file: string, dir: string) => { const r = path.relative(dir, file); return !!r && !r.startsWith("..") && !path.isAbsolute(r); };
export const uploadsDir = (hub: Hub) => path.join(hub.cfg.stateDir, "mail-uploads");

/** A file picked from the PC lands here until the email it's on is sent. Returns what the page sends back as `upload`. */
export function keepUpload(hub: Hub, tmp: string, name: string): { upload: string; name: string } {
  const id = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
  const dir = path.join(uploadsDir(hub), id);
  mkdirSync(dir, { recursive: true });
  renameSync(tmp, path.join(dir, safeName(name)));
  return { upload: `${id}/${safeName(name)}`, name: safeName(name) };
}

export async function composeFiles(hub: Hub, list: ComposeBody["attachments"] = []): Promise<string[]> {
  const out: string[] = [];
  for (const a of list) {
    if ("msg" in a) {
      // An attachment carried along from the email being forwarded: fetched from Gmail once.
      if (!/^[\w-]+$/.test(a.msg) || !hub.gmail.attachment) throw new Error(`Attachment not found: ${a.name}`);
      const file = path.join(uploadsDir(hub), `fw-${a.msg}`, safeName(a.name));
      if (!existsSync(file)) {
        mkdirSync(path.dirname(file), { recursive: true });
        writeFileSync(file, await hub.gmail.attachment(a.msg, a.id));
      }
      out.push(file);
      continue;
    }
    const root = "upload" in a ? uploadsDir(hub) : hub.jobs.folder(a.job);
    const file = path.join(root, "upload" in a ? a.upload : a.path);
    if (!inside(file, root) || !existsSync(file)) throw new Error(`Attachment not found: ${"upload" in a ? a.upload.split("/").pop() : a.path}`);
    out.push(file);
  }
  return out;
}

export async function saveCompose(hub: Hub, b: ComposeBody): Promise<ComposeSaved> {
  let draftId = b.draftId || "";
  if (!draftId && b.draftMsgId) {
    draftId = (await hub.gmail.draftIdFor?.(b.draftMsgId)) ?? "";
    if (!draftId) throw new Error("That draft isn't in Gmail any more (sent or deleted?).");
  }
  const files = await composeFiles(hub, b.attachments);
  // What the draft already carried: fetched from Gmail once, then kept beside Keystone so every later save has it.
  if (draftId && b.keep?.length) {
    const dir = path.join(hub.cfg.stateDir, "draft-attachments", draftId);
    const missing = b.keep.filter((n) => !existsSync(path.join(dir, safeName(n))));
    if (missing.length && b.threadId && b.draftMsgId && hub.gmail.attachment) {
      const th = await hub.gmail.getThread(b.threadId).catch(() => null);
      const m = th?.messages.find((x) => x.id === b.draftMsgId);
      for (const a of m?.attachments ?? []) {
        if (!missing.includes(a.filename)) continue;
        mkdirSync(dir, { recursive: true });
        writeFileSync(path.join(dir, safeName(a.filename)), await hub.gmail.attachment(m!.id, a.id));
      }
    }
    for (const n of b.keep) { const f = path.join(dir, safeName(n)); if (existsSync(f)) files.unshift(f); else throw new Error(`Couldn't keep the attachment ${n}. Nothing was changed.`); }
  }
  const gen = !!draftId && generatedDrafts(hub).some((g) => g.draftId === draftId || (!!b.header && g.messageId === b.header));
  const reply = !!(b.threadId && (b.inReplyTo || b.inThread));
  const input = {
    to: split(b.to), cc: split(b.cc), bcc: split(b.bcc), subject: String(b.subject ?? ""),
    body: String(b.body ?? "") || (b.html ? htmlToText(b.html) : ""),
    html: b.html, quoteHtml: b.quoteHtml || undefined,
    attachments: [...new Set(files)],
    threadId: reply ? b.threadId : undefined, inReplyTo: reply ? b.inReplyTo || undefined : undefined, references: reply ? b.references || undefined : undefined,
    labels: gen ? [GENERATED_LABEL] : undefined,
  };
  if (draftId) {
    if (!hub.gmail.updateDraft) throw new Error("This Gmail connection can't edit drafts.");
    const r = await hub.gmail.updateDraft(draftId, input, b.header);
    return { draftId, messageId: r.messageId || b.draftMsgId || draftId, header: b.header ?? "", threadId: b.threadId };
  }
  const ref = await hub.gmail.createDraft(input);
  return { draftId: ref.id, messageId: ref.gmailId ?? ref.id, header: ref.messageId, threadId: ref.threadId ?? b.threadId };
}

export async function discardCompose(hub: Hub, b: { draftId?: string; draftMsgId?: string }): Promise<boolean> {
  const id = b.draftId || (b.draftMsgId ? await hub.gmail.draftIdFor?.(b.draftMsgId).catch(() => null) : null);
  if (!id || !hub.gmail.deleteDraft) return false;
  await hub.gmail.deleteDraft(id);
  return true;
}
