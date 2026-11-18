import type { Hub } from "../hub.js";

/**
 * Hunter's task format: the job's name first, then what to do, so a job's tasks sort together:
 *   "Belvill - check in on selections"   "Belvill - update estimate and send to homeowners"
 * The job number goes in the task's notes ("Job #3184"), where Keystone reads it back.
 */
const TAG = /\s*(?:\(?\s*(?:re|for|on)?\s*#(\d{3,6})\s*\)?)\s*/i;

export function jobTaskTitle(jobName: string, action: string): string {
  const name = jobName.trim();
  let what = action.replace(TAG, " ").replace(/\s{2,}/g, " ").trim().replace(/^[-–—:\s]+/, "");
  // Already in the format (or starting with the name): don't repeat it.
  if (name && what.toLowerCase().startsWith(`${name.toLowerCase()} -`)) return what;
  if (name && what.toLowerCase().startsWith(name.toLowerCase())) what = what.slice(name.length).replace(/^[\s:–—-]+/, "");
  // "Send Eileen the photos" -> "send Eileen the photos" (only the first word; names stay capitalised).
  what = what.replace(/^([A-Z])([a-z]+)\b/, (_m, a: string, b: string) => a.toLowerCase() + b);
  return name ? `${name} - ${what}` : what;
}

/** The notes with the job's number in them, once. */
export function withJobNote(notes: string | undefined, jobNumber: number): string {
  const n = (notes ?? "").trim();
  return new RegExp(`#${jobNumber}\\b`).test(n) ? n : [`Job #${jobNumber}`, n].filter(Boolean).join("\n");
}

/** A title in the old style ("Call Eileen re #3226") put into the new one, or null when it doesn't need it. */
export function newStyleTitle(hub: Hub, title: string): { title: string; jobNumber: number } | null {
  const m = title.match(/#(\d{3,6})\b/);
  if (!m) return null;
  const n = Number(m[1]);
  if (!hub.jobs.exists(n)) return null;
  const t = jobTaskTitle(hub.jobs.get(n).name, title);
  return t === title ? null : { title: t, jobNumber: n };
}

/** Renames open tasks still in the old style, so every job's tasks group together. Returns how many changed. */
export async function reformatOpenTasks(hub: Hub): Promise<number> {
  if (!hub.tasks.connected()) return 0;
  let n = 0;
  for (const t of await hub.tasks.tasks().catch(() => [])) {
    if (t.completed) continue;
    const to = newStyleTitle(hub, t.title);
    if (!to) continue;
    await hub.tasks.update(t.listId, t.id, { title: to.title, notes: withJobNote(t.notes, to.jobNumber) }).then(() => n++).catch(() => {});
  }
  return n;
}
