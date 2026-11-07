import { AsyncLocalStorage } from "node:async_hooks";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { DraftInput, DraftRef } from "../connectors/gmail/types.js";
import type { Hub } from "../hub.js";

/**
 * Drafts Keystone made for Hunter (Claude's replies, Plan my day, the send-off, the Estimator tab), kept apart from
 * the ones he writes himself so they're easy to find: the Gmail tab's "Claude drafts" folder lists them, and in
 * Gmail itself they carry the "Claude drafts" label. A draft drops off the folder once it's sent or deleted.
 */
export const GENERATED_LABEL = "Claude drafts";

export interface GeneratedDraft {
  draftId: string;
  messageId: string;
  threadId?: string;
  to: string[];
  subject: string;
  snippet: string;
  attachments: number;
  jobNumber?: number;
  /** What made it: "Send-off", "Plan my day", "Estimator", "Claude". */
  source: string;
  createdAt: string;
  state?: "draft" | "sent" | "gone";
  sentAt?: string;
  checkedAt?: string;
}

const where = new AsyncLocalStorage<{ source: string; made?: GeneratedDraft[] }>();
/** Runs `fn` with drafts it makes credited to `source` ("Plan my day", ...). `made` collects them as they're made. */
export function withDraftSource<T>(source: string, fn: () => Promise<T>, made?: GeneratedDraft[]): Promise<T> {
  return where.run({ source, made }, fn);
}

const file = (hub: Hub) => path.join(hub.cfg.stateDir, "generated-drafts.json");
export function generatedDrafts(hub: Hub): GeneratedDraft[] {
  try {
    return existsSync(file(hub)) ? JSON.parse(readFileSync(file(hub), "utf8")) : [];
  } catch {
    return [];
  }
}
function save(hub: Hub, list: GeneratedDraft[]) {
  mkdirSync(hub.cfg.stateDir, { recursive: true });
  writeFileSync(file(hub), JSON.stringify(list.slice(-300), null, 2));
}

/** Makes a Gmail draft for Keystone and files it under Claude drafts. Every hub-made draft goes through here. */
export async function createGeneratedDraft(hub: Hub, d: DraftInput, meta: { jobNumber?: number; source?: string } = {}): Promise<DraftRef> {
  const ref = await hub.gmail.createDraft({ ...d, labels: [GENERATED_LABEL] });
  const list = generatedDrafts(hub);
  list.push({
    draftId: ref.id,
    messageId: ref.messageId,
    threadId: ref.threadId,
    to: d.to,
    subject: d.subject,
    snippet: d.body.replace(/\s+/g, " ").trim().slice(0, 160),
    attachments: d.attachments.length,
    jobNumber: meta.jobNumber,
    source: meta.source ?? where.getStore()?.source ?? "Claude",
    createdAt: new Date().toISOString(),
    state: "draft",
  });
  save(hub, list);
  where.getStore()?.made?.push(list[list.length - 1]);
  return ref;
}

/** Keystone's drafts still waiting in Gmail, newest first (checks whether each is still a draft every few minutes). */
export async function openGeneratedDrafts(hub: Hub): Promise<GeneratedDraft[]> {
  const list = generatedDrafts(hub);
  let changed = false;
  const fresh = Date.now() - 3 * 60_000;
  await Promise.all(
    list
      .filter((g) => g.state === "draft" && (!g.checkedAt || Date.parse(g.checkedAt) < fresh))
      .slice(-60)
      .map(async (g) => {
        const st = await hub.gmail.draftStatus({ id: g.draftId, messageId: g.messageId, threadId: g.threadId }).catch(() => null);
        if (!st) return;
        g.state = st.state;
        if (st.sentAt) g.sentAt = st.sentAt;
        g.checkedAt = new Date().toISOString();
        changed = true;
      }),
  );
  if (changed) save(hub, list);
  return list.filter((g) => g.state === "draft").reverse();
}
