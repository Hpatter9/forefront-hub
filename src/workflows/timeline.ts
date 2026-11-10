import { jobTexts } from "./texts.js";
import { intakeAddress } from "../connectors/homebase/types.js";
import type { Hub } from "../hub.js";

/**
 * One timeline per job, newest first, that fills itself in: Homebase notes, the Activity log (calls, texts,
 * meetings), every email Homebase filed via the office+<job#> BCC, the job's Gmail conversations, and Keystone's own
 * drafts. Read-only; nothing here writes anywhere.
 */
export interface TimelineItem {
  at: string;
  kind: "note" | "call" | "text" | "meeting" | "email" | "draft" | "other";
  direction?: "in" | "out";
  title: string;
  body?: string;
  who?: string;
  source: "homebase-note" | "homebase-activity" | "homebase-email" | "gmail" | "hub" | "iphone";
  threadId?: string;
}

export async function timeline(hub: Hub, jobNumber: number): Promise<TimelineItem[]> {
  const items: TimelineItem[] = [];
  const job = hub.jobs.exists(jobNumber) ? hub.jobs.get(jobNumber) : null;
  const [detail, activity, emails] = await Promise.all([
    hub.homebase.getJob(jobNumber).catch(() => null),
    hub.homebase.activity?.(jobNumber).catch(() => []) ?? Promise.resolve([]),
    hub.homebase.emails?.(jobNumber).catch(() => []) ?? Promise.resolve([]),
  ]);

  for (const n of detail?.notes ?? []) {
    const [who, ...rest] = n.body.split(": ");
    items.push({ at: n.at, kind: "note", title: "Note", body: rest.length ? rest.join(": ") : n.body, who: rest.length ? who : undefined, source: "homebase-note" });
  }
  for (const a of activity) {
    if (/email/i.test(a.type)) continue; // the filed email itself is listed below, with more detail
    const kind = /call/i.test(a.type) ? "call" : /text|sms/i.test(a.type) ? "text" : /meet/i.test(a.type) ? "meeting" : "other";
    items.push({ at: a.on, kind, direction: a.direction === "Inbound" ? "in" : a.direction === "Outbound" ? "out" : undefined, title: a.subject, body: a.details ?? undefined, who: [a.who, a.owner].filter(Boolean).join(" · ") || undefined, source: "homebase-activity" });
  }
  const seen = new Set<string>();
  const key = (subject: string, at: string) => `${subject.replace(/^(re|fwd?|fw):\s*/gi, "").toLowerCase()}|${at.slice(0, 16)}`;
  for (const e of emails) {
    seen.add(key(e.subject, e.sentAt));
    items.push({ at: e.sentAt, kind: "email", direction: e.direction, title: e.subject, body: e.preview, who: e.direction === "out" ? `to ${e.to.join(", ")}` : `from ${e.fromName || e.from}`, source: "homebase-email" });
  }

  // Gmail: conversations with the job's people or mentioning its address (when Gmail is connected).
  if (hub.gmail.kind === "google" && job) {
    const people = [job.customer.email, job.adjuster.email].filter(Boolean);
    const street = job.address.split(",")[0];
    const q = [...people.map((p) => `from:${p} OR to:${p}`), `"${intakeAddress(jobNumber)}"`, street ? `"${street}"` : ""].filter(Boolean).join(" OR ");
    const threads = await hub.gmail.search(`(${q}) newer_than:180d`, 20).catch(() => []);
    for (const t of threads) {
      if (seen.has(key(t.subject, new Date(t.date).toISOString()))) continue;
      items.push({ at: new Date(t.date).toISOString(), kind: "email", title: t.subject, body: t.snippet, who: t.from, source: "gmail", threadId: t.id });
    }
  }

  for (const d of job?.sendoff.drafts ?? []) {
    if (d.sentAt) continue; // once sent it shows up as an email
    items.push({ at: d.createdAt, kind: "draft", direction: "out", title: d.subject, who: `to ${d.to.join(", ")}`, body: `Draft in Gmail · ${d.attachments.join(", ")}`, source: "hub" });
  }

  // Texts with the people on the job (from the iPhone backup).
  for (const t of jobTexts(hub, jobNumber)) items.push({ at: t.at, kind: "text", direction: t.fromMe ? "out" : "in", title: t.fromMe ? `Text to ${t.who}` : `Text from ${t.who}`, body: t.text, who: t.role, source: "iphone" });

  return items.filter((i) => i.at).sort((a, b) => b.at.localeCompare(a.at));
}
