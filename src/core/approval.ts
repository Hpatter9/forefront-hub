import { createInterface } from "node:readline/promises";

/**
 * Everything irreversible goes through an Approver: Homebase writes (stage, proposal, fields, notes, files), sending
 * an email, and overwriting an estimate. Creating a Gmail draft does not ask.
 */
export interface Approver {
  confirm(action: string, details?: string[]): Promise<boolean>;
  /** Like confirm, but shows `text` for Hunter to edit; resolves the (edited) text, or null for no. */
  confirmText?(action: string, details: string[], text: string): Promise<string | null>;
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
}
