import { createInterface } from "node:readline/promises";

/**
 * Everything irreversible goes through an Approver: Homebase writes (stage, proposal, contract, notes) and
 * overwriting an estimate. Gmail is drafts-only, so creating a draft does not ask.
 */
export interface Approver {
  confirm(action: string, details?: string[]): Promise<boolean>;
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
  asked: { action: string; details: string[] }[] = [];
  constructor(private answer: boolean) {}
  async confirm(action: string, details: string[] = []): Promise<boolean> {
    this.asked.push({ action, details });
    return this.answer;
  }
}
