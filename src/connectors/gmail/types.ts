/** Gmail, drafts only. There is deliberately no send method: Hunter sends every email himself. */
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
}

export interface Message {
  id: string;
  from: string;
  to: string[];
  cc: string[];
  date: string;
  subject: string;
  body: string;
  attachments: { id: string; filename: string; mimeType: string }[];
}

export interface MailClient {
  readonly kind: "mock" | "google";
  createDraft(d: DraftInput): Promise<DraftRef>;
  draftStatus(ref: DraftRef): Promise<DraftStatus>;
  search(q: string, max?: number): Promise<ThreadSummary[]>;
  getThread(id: string): Promise<{ id: string; messages: Message[] }>;
  saveAttachments(messageId: string, destDir: string, filter?: RegExp): Promise<string[]>;
}
