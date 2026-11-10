/**
 * Gmail. Claude and the workflows only ever make drafts (createDraft). `send` exists for the Mail tab, where Hunter
 * presses Send himself and confirms; nothing calls it on its own.
 */
export interface DraftInput {
  to: string[];
  cc?: string[];
  bcc: string[];
  subject: string;
  /** Plain text in Hunter's voice; paragraphs separated by blank lines. The Gmail signature is appended. */
  body: string;
  /** Local file paths, attached as-is. */
  attachments: string[];
  /** Put the draft in an existing thread (a reply). */
  threadId?: string;
  inReplyTo?: string;
  /** Gmail labels to put on the draft (created if missing), e.g. "Claude drafts". */
  labels?: string[];
}

export interface DraftRef {
  id: string;
  messageId: string; // the RFC 822 Message-ID header we set, used to find the email once it's sent
  threadId?: string;
}

export interface DraftStatus {
  state: "draft" | "sent" | "gone";
  sentAt?: string;
}

export interface ThreadSummary {
  id: string;
  subject: string;
  from: string;
  date: string;
  snippet: string;
  messageCount: number;
  /** The newest message's To and Cc lines, as written (search results). */
  to?: string;
  cc?: string;
  unread?: boolean;
  starred?: boolean;
  labelIds?: string[];
  hasAttachments?: boolean;
  /** Changes whenever the thread changes; used to skip refetching unchanged threads. */
  historyId?: string;
}

export interface Message {
  id: string;
  from: string;
  to: string[];
  cc: string[];
  /** Only drafts (and your own sent mail) carry a Bcc line. */
  bcc?: string[];
  date: string;
  subject: string;
  body: string;
  /** The HTML part as Gmail has it (shown in a sandboxed frame). */
  html?: string;
  /** RFC 822 Message-ID, for replies. */
  messageIdHeader?: string;
  labelIds?: string[];
  attachments: { id: string; filename: string; mimeType: string; size?: number }[];
}

export interface Label {
  id: string;
  name: string;
  type: "system" | "user";
  unread?: number;
}

export interface MailClient {
  readonly kind: "mock" | "google";
  createDraft(d: DraftInput): Promise<DraftRef>;
  draftStatus(ref: DraftRef): Promise<DraftStatus>;
  search(q: string, max?: number): Promise<ThreadSummary[]>;
  /** With historyId (from a listing), an unchanged thread can come from cache. */
  getThread(id: string, historyId?: string): Promise<{ id: string; messages: Message[] }>;
  saveAttachments(messageId: string, destDir: string, filter?: RegExp): Promise<string[]>;

  // ---- the Mail tab
  /** One page of a mailbox: a label (INBOX, SENT, DRAFT, STARRED, a user label) and/or a Gmail search. */
  listThreads?(o: { label?: string; q?: string; pageToken?: string; max?: number }): Promise<{ threads: ThreadSummary[]; nextPageToken?: string }>;
  labels?(): Promise<Label[]>;
  /**
   * Sends now. Called by the Mail tab's Send button (after Hunter confirms) and by auto-filing, which forwards job
   * emails only to Forefront's own office+<job#> log addresses.
   */
  send?(d: DraftInput): Promise<{ id: string; threadId: string; messageId: string }>;
  /** Sends an existing draft as it is (attachments included). Only the Mail tab's Send button calls it, after Hunter confirms. */
  sendDraft?(draftId: string): Promise<void>;
  deleteDraft?(draftId: string): Promise<void>;
  /** Replaces a draft's contents in place (same draft, same thread). Returns the new message id. */
  updateDraft?(draftId: string, d: DraftInput, keepMessageId?: string): Promise<{ messageId: string }>;
  /** The draft id for a draft message in a thread (Gmail keeps the two apart). */
  draftIdFor?(messageId: string): Promise<string | null>;
  /** Archive (remove INBOX), mark read (remove UNREAD), star, trash. */
  modifyThread?(id: string, change: { add?: string[]; remove?: string[]; trash?: boolean; untrash?: boolean }): Promise<void>;
  attachment?(messageId: string, attachmentId: string): Promise<Buffer>;
  /** The id of a user label with this name, created if needed. */
  ensureLabel?(name: string): Promise<string>;
  /** False when Gmail was connected before the Mail tab existed (drafts + read only): reconnect to send/archive. */
  fullAccess?(): boolean;
}
