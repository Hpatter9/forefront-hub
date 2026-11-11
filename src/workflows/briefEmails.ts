import { intakeAddress } from "../connectors/homebase/types.js";
import type { Hub } from "../hub.js";
import { allSigns, belongsToJob } from "./jobMail.js";

/**
 * Checks every "View email" button in a brief before it's shown, so each one opens the email the line is about.
 * A button stays when the thread is about that line's job: it was the job's waiting email, or the thread involves the
 * job's customer or adjuster, its Homebase address, its job number or street in the subject. Otherwise it's swapped
 * for the job's own waiting email when there is one, or dropped. Lines without a job keep a button only for a
 * thread Keystone itself pointed to.
 */
export async function checkEmailButtons(hub: Hub, text: string, known: { threadId?: string; jobNumber: number }[] = []): Promise<{ text: string; fixed: number; dropped: number }> {
  let fixed = 0;
  let dropped = 0;
  const knownIds = new Set(known.map((k) => k.threadId).filter(Boolean));
  const cache = new Map<string, { text: string; people: string[] } | null>();
  const all = allSigns(hub);
  const threadText = async (id: string) => {
    if (!cache.has(id)) {
      const t = await hub.gmail.getThread(id).catch(() => null);
      cache.set(id, t ? { text: t.messages.map((m) => [m.subject, m.body, ...m.to, ...m.cc, ...(m.bcc ?? [])].join(" ")).join("\n"), people: t.messages.flatMap((m) => [m.from, ...m.to, ...m.cc]) } : null);
    }
    return cache.get(id)!;
  };
  const lines = text.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const ids = [...lines[i].matchAll(/\{email:([\w-]{6,})\}/g)].map((m) => m[1]);
    if (!ids.length) continue;
    const jobNumber = Number(lines[i].match(/\{go:(\d+):/)?.[1] ?? lines[i].match(/#(\d{3,6})\b/)?.[1] ?? 0);
    const job = jobNumber && hub.jobs.exists(jobNumber) ? hub.jobs.get(jobNumber) : null;
    const jobWaiting = job?.pulse.waiting?.threadId || known.find((k) => k.jobNumber === jobNumber && k.threadId)?.threadId || "";
    let line = lines[i];
    for (const id of ids) {
      const body = await threadText(id);
      let ok = false;
      if (body !== null) {
        if (!job) ok = knownIds.has(id);
        else {
          // The same test as everywhere else: an address shared with other jobs isn't enough on its own.
          ok = id === jobWaiting || belongsToJob(all, job.jobNumber, body.text, body.people).belongs;
        }
      }
      if (ok) continue;
      if (jobWaiting && jobWaiting !== id && !ids.includes(jobWaiting) && (await threadText(jobWaiting)) !== null) {
        line = line.replace(`{email:${id}}`, `{email:${jobWaiting}}`);
        fixed++;
      } else {
        line = line.replace(new RegExp(`\\s*\\{email:${id}\\}`), "");
        dropped++;
      }
    }
    lines[i] = line;
  }
  return { text: lines.join("\n"), fixed, dropped };
}
