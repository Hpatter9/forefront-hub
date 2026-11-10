import { intakeAddress } from "../connectors/homebase/types.js";
import type { Hub } from "../hub.js";

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
  const cache = new Map<string, string | null>();
  const threadText = async (id: string) => {
    if (!cache.has(id)) {
      const t = await hub.gmail.getThread(id).catch(() => null);
      cache.set(id, t ? t.messages.map((m) => [m.subject, m.from, ...m.to, ...m.cc, ...(m.bcc ?? [])].join(" ")).join(" ").toLowerCase() : null);
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
          const street = job.address.split(",")[0].trim().toLowerCase();
          const marks = [job.customer.email, job.adjuster.email, intakeAddress(job.jobNumber), `#${job.jobNumber}`, `${job.jobNumber} `, street.length >= 6 ? street : ""].map((x) => x.toLowerCase()).filter(Boolean);
          ok = id === jobWaiting || marks.some((m) => body.includes(m));
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
