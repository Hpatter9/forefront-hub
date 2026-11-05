/**
 * Homebase (https://homebase.forefrontteam.com), Forefront's system of record. Everything else in the hub talks to
 * Homebase only through this interface, so the browser-driven version can be swapped for an API version
 * (HOMEBASE_DRIVER=api) without touching anything else. See docs/homebase-api.md.
 */
export interface JobSummary {
  id: string; // /projects/<uuid>
  jobNumber: number;
  name: string;
  address: string;
  stage: string;
  stageSince?: string; // ISO date the job entered its stage
  lastActivityAt?: string;
  url: string;
  people?: { estimator?: string; projectManager?: string; owner?: string };
  proposalAmount?: number;
}

export interface Contact {
  role: "customer" | "adjuster" | "other";
  name: string;
  email: string;
  phone: string;
}

export interface JobDetail extends JobSummary {
  contacts: Contact[];
  carrier: string;
  claimNumber: string;
  proposalAmount?: number;
  proposalSubmittedAt?: string;
  contractAmount?: number;
  intakeEmail: string;
  dateOfLoss?: string;
  /** The CompanyCam link on the job, when Homebase has one. */
  picturesLink?: string;
  notes: { at: string; body: string }[];
  /** The job page as text, for the agent to read anything the parser missed. */
  text?: string;
}

export interface HomebaseClient {
  readonly kind: "mock" | "browser" | "api";
  /** `mine`: only jobs where this person is the estimator, PM or owner. `details`: fill in days in stage (slower). */
  listJobs(filter?: { openOnly?: boolean; mine?: string; details?: boolean }): Promise<JobSummary[]>;
  getJob(jobNumber: number): Promise<JobDetail>;
  /**
   * Proposal amount AND submitted date, always together: Homebase's Day 2/5/10/21 follow-ups key off the date.
   * The real API stamps the date itself (the day of the write), so `submittedAt` is only honoured by drivers that can.
   */
  setProposal(jobNumber: number, p: { amount: number; submittedAt: string }): Promise<void>;
  setContractAmount(jobNumber: number, amount: number): Promise<void>;
  /** `fromStage`: the stage you read; the API refuses the move if the job has moved since. */
  setStage(jobNumber: number, stage: string, fromStage?: string): Promise<void>;
  /** A call goes in the job's Activity log (first line = subject), a note on its Notes feed. */
  addNote(jobNumber: number, note: { kind: "note" | "call"; body: string; who?: string; direction?: "Inbound" | "Outbound" }): Promise<void>;
  close?(): Promise<void>;
}

/** BCC this and Homebase files the email to the job. */
export function intakeAddress(jobNumber: number): string {
  return `office+${jobNumber}@forefrontteam.com`;
}
