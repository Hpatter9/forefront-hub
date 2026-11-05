import type { HomebaseClient, JobDetail, JobSummary } from "./types.js";

/**
 * Homebase over the JSON API proposed in docs/homebase-api-spec.md. It doesn't exist yet; once it does, set
 * HOMEBASE_DRIVER=api and HOMEBASE_API_TOKEN and nothing else in the hub changes.
 */
export class ApiHomebase implements HomebaseClient {
  readonly kind = "api" as const;

  constructor(private opts: { url: string; token: string; fetch?: typeof fetch }) {}

  private async call<T>(method: string, path: string, body?: unknown): Promise<T> {
    const res = await (this.opts.fetch ?? fetch)(`${this.opts.url}/api/v1${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${this.opts.token}`,
        "Content-Type": "application/json",
        ...(method === "GET" ? {} : { "Idempotency-Key": crypto.randomUUID() }),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    if (!res.ok) throw new Error(`Homebase API ${method} ${path}: ${res.status} ${await res.text()}`);
    return res.status === 204 ? (undefined as T) : ((await res.json()) as T);
  }

  async listJobs(filter: { openOnly?: boolean } = {}): Promise<JobSummary[]> {
    const q = new URLSearchParams({ department: "reconstruction", assignee: "me", ...(filter.openOnly ? { status: "open" } : {}) });
    const { data } = await this.call<{ data: any[] }>("GET", `/projects?${q}`);
    return data.map(toSummary);
  }

  async getJob(jobNumber: number): Promise<JobDetail> {
    const p = await this.call<any>("GET", `/projects/by-number/${jobNumber}`);
    return {
      ...toSummary(p),
      contacts: (p.contacts ?? []).map((c: any) => ({ role: c.role, name: c.name ?? "", email: c.email ?? "", phone: c.phone ?? "" })),
      carrier: p.carrier ?? "",
      claimNumber: p.claim_number ?? "",
      proposalAmount: p.proposal_amount ?? undefined,
      proposalSubmittedAt: p.proposal_submitted_at ?? undefined,
      contractAmount: p.contract_amount ?? undefined,
      intakeEmail: p.intake_email ?? `office+${jobNumber}@forefrontteam.com`,
      notes: (p.notes ?? []).map((n: any) => ({ at: n.occurred_at, body: n.body })),
    };
  }

  private async id(jobNumber: number) {
    return (await this.call<any>("GET", `/projects/by-number/${jobNumber}`)).id as string;
  }

  async setProposal(jobNumber: number, p: { amount: number; submittedAt: string }) {
    if (!(p.amount > 0) || !p.submittedAt) throw new Error("setProposal needs both an amount and a submitted date");
    await this.call("PATCH", `/projects/${await this.id(jobNumber)}/financials`, {
      proposal_amount: p.amount,
      proposal_submitted_at: p.submittedAt,
    });
  }

  async setContractAmount(jobNumber: number, amount: number) {
    await this.call("PATCH", `/projects/${await this.id(jobNumber)}/financials`, { contract_amount: amount });
  }

  async setStage(jobNumber: number, stage: string) {
    await this.call("POST", `/projects/${await this.id(jobNumber)}/stage`, { stage });
  }

  async addNote(jobNumber: number, note: { kind: "note" | "call"; body: string }) {
    await this.call("POST", `/projects/${await this.id(jobNumber)}/notes`, {
      kind: note.kind,
      body: note.body,
      occurred_at: new Date().toISOString(),
    });
  }
}

function toSummary(p: any): JobSummary {
  return {
    id: p.id,
    jobNumber: p.job_number,
    name: p.name ?? "",
    address: p.address ?? "",
    stage: p.stage ?? "",
    stageSince: p.stage_entered_at ?? undefined,
    lastActivityAt: p.last_activity_at ?? undefined,
    url: p.url ?? "",
  };
}
