import type { ServerResponse } from "node:http";
import type { Approver } from "../core/approval.js";

export type HubEvent =
  | { type: "log"; text: string; job?: number }
  | { type: "approval"; id: string; action: string; details: string[]; text?: string }
  | { type: "approval-done"; id: string; answer: boolean }
  | { type: "task"; id: string; state: "running" | "done" | "error"; label: string; error?: string; job?: number }
  | { type: "changed"; job?: number; what: "timeline" | "mail" | "job" };

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
  private pending = new Map<string, (yes: boolean, text?: string) => void>();
  constructor(private bus: EventBus, private timeoutMs = 15 * 60_000) {}

  private ask(action: string, details: string[], text?: string): Promise<{ yes: boolean; text?: string }> {
    const id = crypto.randomUUID();
    return new Promise((resolve) => {
      const done = (yes: boolean, edited?: string) => {
        if (!this.pending.has(id)) return;
        this.pending.delete(id);
        clearTimeout(timer);
        this.bus.emit({ type: "approval-done", id, answer: yes });
        resolve({ yes, text: edited ?? text });
      };
      const timer = setTimeout(() => done(false), this.timeoutMs);
      this.pending.set(id, done);
      this.bus.emit({ type: "approval", id, action, details, text });
    });
  }

  async confirm(action: string, details: string[] = []): Promise<boolean> {
    return (await this.ask(action, details)).yes;
  }

  async confirmText(action: string, details: string[], text: string): Promise<string | null> {
    const r = await this.ask(action, details, text);
    return r.yes && r.text?.trim() ? r.text.trim() : null;
  }

  answer(id: string, yes: boolean, text?: string): boolean {
    const f = this.pending.get(id);
    if (!f) return false;
    f(yes, text);
    return true;
  }
}
