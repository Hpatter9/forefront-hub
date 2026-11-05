import type { ServerResponse } from "node:http";
import type { Approver } from "../core/approval.js";

export type HubEvent =
  | { type: "log"; text: string; job?: number }
  | { type: "approval"; id: string; action: string; details: string[] }
  | { type: "approval-done"; id: string; answer: boolean }
  | { type: "task"; id: string; state: "running" | "done" | "error"; label: string; error?: string; job?: number };

/** Server-sent events to every open window. */
export class EventBus {
  private clients = new Set<ServerResponse>();
  private recent: HubEvent[] = [];

  attach(res: ServerResponse) {
    res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", Connection: "keep-alive" });
    res.write(": hello\n\n");
    for (const e of this.recent) res.write(`data: ${JSON.stringify(e)}\n\n`);
    this.clients.add(res);
    const ping = setInterval(() => res.write(": ping\n\n"), 20000);
    res.on("close", () => {
      clearInterval(ping);
      this.clients.delete(res);
    });
  }

  emit(e: HubEvent) {
    // Keep pending approvals around so a window opened later still sees them.
    if (e.type === "approval") this.recent.push(e);
    if (e.type === "approval-done") this.recent = this.recent.filter((r) => !(r.type === "approval" && r.id === e.id));
    for (const c of this.clients) c.write(`data: ${JSON.stringify(e)}\n\n`);
  }
}

/** Asks in the browser: a confirm card appears in every open window; the first answer wins. */
export class WebApprover implements Approver {
  private pending = new Map<string, (yes: boolean) => void>();
  constructor(private bus: EventBus, private timeoutMs = 15 * 60_000) {}

  confirm(action: string, details: string[] = []): Promise<boolean> {
    const id = crypto.randomUUID();
    return new Promise((resolve) => {
      const done = (yes: boolean) => {
        if (!this.pending.has(id)) return;
        this.pending.delete(id);
        clearTimeout(timer);
        this.bus.emit({ type: "approval-done", id, answer: yes });
        resolve(yes);
      };
      const timer = setTimeout(() => done(false), this.timeoutMs);
      this.pending.set(id, done);
      this.bus.emit({ type: "approval", id, action, details });
    });
  }

  answer(id: string, yes: boolean): boolean {
    const f = this.pending.get(id);
    if (!f) return false;
    f(yes);
    return true;
  }
}
