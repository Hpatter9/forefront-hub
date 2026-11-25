import { AsyncLocalStorage } from "node:async_hooks";
import { createInterface } from "node:readline/promises";

/**
 * Cards asked from background work (the proposal check, Proposal Submitted Notes, the brief's Homebase steps,
 * Claude's results from Drive) wait in the "To review" list instead of popping up, so they can be answered in one
 * sitting. Code run inside asLater() asks that way; everything else (what Hunter just pressed) still pops up.
 */
const cardMode = new AsyncLocalStorage<"later">();
export const asLater = <T>(fn: () => Promise<T>): Promise<T> => cardMode.run("later", fn);
export const askingLater = () => cardMode.getStore() === "later";

/**
 * Everything irreversible goes through an Approver: Homebase writes (stage, proposal, fields, notes, files), sending
 * an email, and overwriting an estimate. Creating a Gmail draft does not ask.
 */
export interface Approver {
  confirm(action: string, details?: string[]): Promise<boolean>;
  /** Like confirm, but shows `text` for Hunter to edit; resolves the (edited) text, or null for no. */
  confirmText?(action: string, details: string[], text: string): Promise<string | null>;
  /** Like confirm, but Hunter may type his own answer instead of Yes or No; `reply` is what he typed. */
  confirmOrReply?(action: string, details: string[]): Promise<{ yes: boolean; reply?: string }>;
}

/** confirmOrReply where the approver has it, else a plain Yes/No. */
export async function confirmOrReply(a: Approver, action: string, details: string[]): Promise<{ yes: boolean; reply?: string }> {
  if (a.confirmOrReply) return a.confirmOrReply(action, details);
  return { yes: await a.confirm(action, details) };
}

/** confirmText where the approver has it, else a plain confirm of the text as written. */
export async function confirmText(a: Approver, action: string, details: string[], text: string): Promise<string | null> {
  if (a.confirmText) return a.confirmText(action, details, text);
  return (await a.confirm(action, [...details, "", text])) ? text : null;
}

export class CliApprover implements Approver {
  async confirm(action: string, details: string[] = []): Promise<boolean> {
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    try {
      console.log(`\n⚠  ${action}`);
      for (const d of details) console.log(`   ${d}`);
      const a = (await rl.question("   Go ahead? [y/N] ")).trim().toLowerCase();
      return a === "y" || a === "yes";
    } finally {
      rl.close();
    }
  }
}

/** For tests and `--yes`: answers every question the same way and remembers what it was asked. */
export class FixedApprover implements Approver {
  asked: { action: string; details: string[]; text?: string }[] = [];
  constructor(private answer: boolean) {}
  async confirm(action: string, details: string[] = []): Promise<boolean> {
    this.asked.push({ action, details });
    return this.answer;
  }
  async confirmText(action: string, details: string[], text: string): Promise<string | null> {
    this.asked.push({ action, details, text });
    return this.answer ? text : null;
  }
  /** Set to answer the next confirmOrReply with typed text. */
  reply?: string;
  async confirmOrReply(action: string, details: string[]): Promise<{ yes: boolean; reply?: string }> {
    this.asked.push({ action, details });
    const reply = this.reply;
    this.reply = undefined;
    return reply ? { yes: false, reply } : { yes: this.answer };
  }
}
