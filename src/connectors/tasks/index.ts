import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { google, type tasks_v1 } from "googleapis";
import type { Config } from "../../core/config.js";
import { GoogleAuth, SCOPES } from "../google/auth.js";

/**
 * Google Tasks, read and write. The hub works on Hunter's real task lists, so a task made in the hub is on his phone
 * and in Chrome at once, and one made on his phone shows in the hub on its next refresh. Google keeps only a due
 * DATE for tasks (no time of day).
 */
export interface TaskList {
  id: string;
  title: string;
}

export interface Task {
  id: string;
  listId: string;
  title: string;
  notes?: string;
  due?: string; // YYYY-MM-DD
  completed: boolean;
  completedAt?: string;
  updated: string;
  link?: string;
  jobNumber?: number;
}

export interface TaskInput {
  listId?: string;
  title?: string;
  notes?: string;
  due?: string | null; // YYYY-MM-DD, null clears
  completed?: boolean;
}

export interface TasksClient {
  readonly kind: "mock" | "google";
  connected(): boolean;
  lists(): Promise<TaskList[]>;
  tasks(o?: { listIds?: string[]; showCompleted?: boolean; dueMin?: string; dueMax?: string }): Promise<Task[]>;
  create(t: TaskInput & { title: string }): Promise<Task>;
  update(listId: string, id: string, t: TaskInput): Promise<Task>;
  remove(listId: string, id: string): Promise<void>;
}

const jobRef = (s: string) => {
  const m = s.match(/#(\d{4})\b/);
  return m ? Number(m[1]) : undefined;
};

export class GoogleTasks implements TasksClient {
  readonly kind = "google" as const;
  private api?: tasks_v1.Tasks;
  constructor(private auth: GoogleAuth) {}

  connected() {
    return this.auth.hasScope(SCOPES.tasks);
  }

  private t() {
    if (!this.connected()) throw new Error("Google Tasks isn't connected yet: double-click Connect Gmail in the hub folder and click Allow (it covers Calendar and Tasks too).");
    this.api ??= google.tasks({ version: "v1", auth: this.auth.client() });
    return this.api;
  }

  private toTask(listId: string, t: tasks_v1.Schema$Task): Task {
    return {
      id: t.id!,
      listId,
      title: t.title || "(no title)",
      notes: t.notes ?? undefined,
      due: t.due ? t.due.slice(0, 10) : undefined,
      completed: t.status === "completed",
      completedAt: t.completed ?? undefined,
      updated: t.updated ?? "",
      link: t.webViewLink ?? undefined,
      jobNumber: jobRef(`${t.title ?? ""} ${t.notes ?? ""}`),
    };
  }

  async lists(): Promise<TaskList[]> {
    const { data } = await this.t().tasklists.list({ maxResults: 100 });
    return (data.items ?? []).map((l) => ({ id: l.id!, title: l.title ?? "Tasks" }));
  }

  async tasks(o: { listIds?: string[]; showCompleted?: boolean; dueMin?: string; dueMax?: string } = {}): Promise<Task[]> {
    const ids = o.listIds?.length ? o.listIds : (await this.lists()).map((l) => l.id);
    const all = await Promise.all(
      ids.map(async (listId) => {
        const out: Task[] = [];
        let pageToken: string | undefined;
        do {
          const { data } = await this.t().tasks.list({
            tasklist: listId,
            maxResults: 100,
            showCompleted: !!o.showCompleted,
            showHidden: !!o.showCompleted,
            dueMin: o.dueMin ? `${o.dueMin.slice(0, 10)}T00:00:00.000Z` : undefined,
            dueMax: o.dueMax ? `${o.dueMax.slice(0, 10)}T23:59:59.000Z` : undefined,
            pageToken,
          });
          out.push(...(data.items ?? []).filter((t) => !t.deleted).map((t) => this.toTask(listId, t)));
          pageToken = data.nextPageToken ?? undefined;
        } while (pageToken);
        return out;
      }),
    );
    return all.flat();
  }

  private body(t: TaskInput): tasks_v1.Schema$Task {
    const b: tasks_v1.Schema$Task = {};
    if (t.title !== undefined) b.title = t.title;
    if (t.notes !== undefined) b.notes = t.notes;
    if (t.due !== undefined) b.due = t.due ? `${t.due.slice(0, 10)}T00:00:00.000Z` : null;
    if (t.completed !== undefined) {
      b.status = t.completed ? "completed" : "needsAction";
      if (!t.completed) b.completed = null;
    }
    return b;
  }

  async create(t: TaskInput & { title: string }): Promise<Task> {
    const listId = t.listId || "@default";
    const { data } = await this.t().tasks.insert({ tasklist: listId, requestBody: this.body(t) });
    return this.toTask(listId, data);
  }

  async update(listId: string, id: string, t: TaskInput): Promise<Task> {
    const { data } = await this.t().tasks.patch({ tasklist: listId, task: id, requestBody: this.body(t) });
    return this.toTask(listId, data);
  }

  async remove(listId: string, id: string): Promise<void> {
    await this.t().tasks.delete({ tasklist: listId, task: id });
  }
}

/** Tasks on disk with a few made-up ones, so the hub works without Google. */
export class MockTasks implements TasksClient {
  readonly kind = "mock" as const;
  private file: string;
  constructor(stateDir: string) {
    this.file = path.join(stateDir, "mock-tasks.json");
  }
  connected() {
    return true;
  }
  private load(): Task[] {
    if (existsSync(this.file)) return JSON.parse(readFileSync(this.file, "utf8"));
    const day = (n: number) => new Date(Date.now() + n * 864e5).toISOString().slice(0, 10);
    return [
      { id: "t1", listId: "default", title: "Send Xactimate to adjuster #9001", due: day(0), completed: false, updated: new Date().toISOString(), jobNumber: 9001 },
      { id: "t2", listId: "default", title: "Follow up with Sam #9002", due: day(-1), completed: false, updated: new Date().toISOString(), jobNumber: 9002 },
      { id: "t3", listId: "default", title: "Order tile samples", due: day(2), completed: false, updated: new Date().toISOString() },
    ];
  }
  private save(t: Task[]) {
    mkdirSync(path.dirname(this.file), { recursive: true });
    writeFileSync(this.file, JSON.stringify(t, null, 2));
  }
  async lists() {
    return [{ id: "default", title: "My Tasks" }];
  }
  async tasks(o: { showCompleted?: boolean; dueMin?: string; dueMax?: string } = {}) {
    return this.load().filter((t) => (o.showCompleted || !t.completed) && (!o.dueMin || !t.due || t.due >= o.dueMin.slice(0, 10)) && (!o.dueMax || !t.due || t.due <= o.dueMax.slice(0, 10)));
  }
  async create(t: TaskInput & { title: string }) {
    const task: Task = { id: `t${Date.now().toString(36)}`, listId: t.listId || "default", title: t.title, notes: t.notes, due: t.due ?? undefined, completed: !!t.completed, updated: new Date().toISOString(), jobNumber: jobRef(`${t.title} ${t.notes ?? ""}`) };
    this.save([...this.load(), task]);
    return task;
  }
  async update(listId: string, id: string, t: TaskInput) {
    const all = this.load();
    const task = all.find((x) => x.id === id);
    if (!task) throw new Error("No such task");
    if (t.title !== undefined) task.title = t.title;
    if (t.notes !== undefined) task.notes = t.notes;
    if (t.due !== undefined) task.due = t.due ?? undefined;
    if (t.completed !== undefined) {
      task.completed = t.completed;
      task.completedAt = t.completed ? new Date().toISOString() : undefined;
    }
    task.updated = new Date().toISOString();
    this.save(all);
    return task;
  }
  async remove(_listId: string, id: string) {
    this.save(this.load().filter((x) => x.id !== id));
  }
}

export function makeTasks(cfg: Config): TasksClient {
  if (cfg.gmail.driver === "google") return new GoogleTasks(new GoogleAuth({ clientId: cfg.gmail.clientId, clientSecret: cfg.gmail.clientSecret, tokenFile: cfg.gmail.tokenFile, address: cfg.gmail.address }));
  return new MockTasks(cfg.stateDir);
}
