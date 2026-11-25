import type { ServerResponse } from "node:http";
import type { StudioEvent } from "../agent/studio.js";
import { askingLater, type Approver } from "../core/approval.js";

export type HubEvent =
  | { type: "log"; text: string; job?: number }
  /** Shown on screen for a few seconds (the result of something Hunter asked for, or a problem he should see). */
  | { type: "notice"; text: string }
  | { type: "approval"; id: string; action: string; details: string[]; text?: string; replyAware?: boolean; /** Waits in "To review" instead of popping up. */ later?: boolean; at?: string }
  | { type: "approval-done"; id: string; answer: boolean }
  | { type: "task"; id: string; state: "running" | "done" | "error"; label: string; error?: string; job?: number }
  | { type: "changed"; job?: number; what: "timeline" | "mail" | "job" | "calendar" | "plan" | "summaries" | "tasks" }
  | ({ type: "studio" } & StudioEvent)
  | { type: "answer"; id: string; ai?: string; conv?: string; turns?: number; prompt: string; text: string; error?: string; drafts: { threadId?: string; subject: string; to: string[] }[]; jobs: number[]; contacts: string[] };

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
  private pending = new Map<string, (yes: boolean, text?: string, reply?: string) => void>();
  constructor(private bus: EventBus, private timeoutMs = 15 * 60_000, private laterTimeoutMs = 3 * 24 * 3600_000) {}

  /**
   * One card. Besides Yes and No, Hunter can type his own answer (`reply`). For a plain confirm the page passes a
   * typed answer on to Keystone's AI as an instruction (replyAware false); confirmOrReply hands it to the caller.
   */
  private ask(action: string, details: string[], text?: string, replyAware = false): Promise<{ yes: boolean; text?: string; reply?: string }> {
    const id = crypto.randomUUID();
    return new Promise((resolve) => {
      const done = (yes: boolean, edited?: string, reply?: string) => {
        if (!this.pending.has(id)) return;
        this.pending.delete(id);
        clearTimeout(timer);
        this.bus.emit({ type: "approval-done", id, answer: yes });
        resolve({ yes, text: edited ?? text, reply: reply?.trim() || undefined });
      };
      // A card in "To review" waits days, not minutes: it's there for the next sitting.
      const later = askingLater();
      const timer = setTimeout(() => done(false), later ? this.laterTimeoutMs : this.timeoutMs);
      this.pending.set(id, done);
      this.bus.emit({ type: "approval", id, action, details, text, replyAware, ...(later ? { later: true, at: new Date().toISOString() } : {}) });
    });
  }

  async confirm(action: string, details: string[] = []): Promise<boolean> {
    const r = await this.ask(action, details);
    return r.yes && !r.reply;
  }

  async confirmText(action: string, details: string[], text: string): Promise<string | null> {
    const r = await this.ask(action, details, text);
    return r.yes && r.text?.trim() ? r.text.trim() : null;
  }

  async confirmOrReply(action: string, details: string[]): Promise<{ yes: boolean; reply?: string }> {
    const r = await this.ask(action, details, undefined, true);
    return r.reply ? { yes: false, reply: r.reply } : { yes: r.yes };
  }

  answer(id: string, yes: boolean, text?: string, reply?: string): boolean {
    const f = this.pending.get(id);
    if (!f) return false;
    f(yes, text, reply);
    return true;
  }
}
