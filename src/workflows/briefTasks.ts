import type { Task } from "../connectors/tasks/index.js";

/**
 * Google Tasks in the brief. Each task gets a short tag (T1, T2...) the AI puts on its line as {task:T1}; Keystone
 * keeps which real task each tag is, so ticking that line in the brief checks the task off in Google Tasks (and on
 * the phone). Any task the AI left out is added under "My tasks", so every due task is always in the brief.
 */
export interface BriefTask {
  listId: string;
  id: string;
  title: string;
}

export function labelTasks(tasks: Task[]): { map: Record<string, BriefTask>; tagOf: (t: Task) => string } {
  const map: Record<string, BriefTask> = {};
  const tags = new Map<Task, string>();
  tasks.forEach((t, i) => {
    const tag = `T${i + 1}`;
    map[tag] = { listId: t.listId, id: t.id, title: t.title };
    tags.set(t, tag);
  });
  return { map, tagOf: (t) => tags.get(t) ?? "" };
}

export function ensureTaskLines(text: string, map: Record<string, BriefTask>): string {
  const lines = text.split("\n");
  // Tags the AI made up don't get a checkbox link.
  for (let i = 0; i < lines.length; i++) lines[i] = lines[i].replace(/\s*\{task:(T\d+)\}/g, (m, tag) => (map[tag] ? m : ""));
  const missing: string[] = [];
  for (const [tag, t] of Object.entries(map)) {
    if (lines.some((l) => l.includes(`{task:${tag}}`))) continue;
    // Mentioned without its tag: tag that line. Not mentioned at all: add it.
    const title = t.title.trim().toLowerCase();
    const at = title.length >= 6 ? lines.findIndex((l) => /^\s*(\d+\.|[-*])\s/.test(l) && l.toLowerCase().includes(title) && !/\{task:T\d+\}/.test(l)) : -1;
    if (at >= 0) lines[at] = `${lines[at].trimEnd()} {task:${tag}}`;
    else missing.push(`- ${t.title} {task:${tag}}`);
  }
  if (!missing.length) return lines.join("\n");
  const head = lines.findIndex((l) => /^\*\*My tasks/i.test(l.trim()));
  if (head >= 0) {
    let end = head + 1;
    while (end < lines.length && lines[end].trim() && !/^\*\*/.test(lines[end].trim())) end++;
    lines.splice(end, 0, ...missing);
    return lines.join("\n");
  }
  return `${lines.join("\n").trimEnd()}\n\n**My tasks** (Google Tasks; ticking one checks it off there too)\n${missing.join("\n")}`;
}
