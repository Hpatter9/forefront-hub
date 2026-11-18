import Anthropic from "@anthropic-ai/sdk";

/**
 * Anthropic's own count of what the account has spent this month, from its Usage and Cost Analytics API. It needs
 * an Admin key (sk-ant-admin..., made by an organization admin in the Claude Console, Settings, Admin keys), set as
 * ANTHROPIC_ADMIN_KEY in .env. It counts everything on the account, not just Keystone, and runs a few hours behind
 * (Anthropic says data lands within 4 hours, sometimes up to 24). Without the key Keystone uses its own tally only.
 */
export interface ClaudeCost {
  readonly kind: "anthropic" | "mock";
  /** Month-to-date spend in dollars (after discounts, before credits), and how far the data reaches. */
  monthToDate(): Promise<{ usd: number; asOf?: string }>;
}

/** The first day of this month, at midnight UTC. */
export const monthStartUtc = (d = new Date()) => `${d.toISOString().slice(0, 7)}-01T00:00:00Z`;

export class LiveClaudeCost implements ClaudeCost {
  readonly kind = "anthropic" as const;
  private cache: { at: number; value: { usd: number; asOf?: string } } | null = null;
  private client: Anthropic;
  constructor(adminKey: string, client?: Anthropic) {
    this.client = client ?? new Anthropic({ apiKey: adminKey });
  }
  async monthToDate() {
    // Anthropic asks for no more than about one read a minute; its data only moves every few hours anyway.
    if (this.cache && Date.now() - this.cache.at < 30 * 60_000) return this.cache.value;
    let cents = 0;
    let asOf: string | undefined;
    const page = this.client.beta.organization.analytics.cost.list({ starting_at: monthStartUtc() });
    for await (const row of page) {
      cents += Number(row.cost.amount) || 0;
      if (!asOf || row.ending_at > asOf) asOf = row.ending_at;
    }
    const value = { usd: Math.round(cents) / 100, asOf };
    this.cache = { at: Date.now(), value };
    return value;
  }
}

export class MockClaudeCost implements ClaudeCost {
  readonly kind = "mock" as const;
  constructor(private usd = 0) {}
  async monthToDate() { return { usd: this.usd, asOf: new Date().toISOString() }; }
}

export function makeClaudeCost(adminKey: string): ClaudeCost | null {
  return adminKey.startsWith("sk-ant-admin") ? new LiveClaudeCost(adminKey) : null;
}
