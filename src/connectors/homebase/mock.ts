import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { HUB_ROOT } from "../../core/config.js";
import type { HomebaseClient, JobDetail } from "./types.js";

export interface MockWrite {
  at: string;
  jobNumber: number;
  op: "setProposal" | "setContractAmount" | "setStage" | "addNote";
  args: unknown;
}

/** Homebase on fixture data. Writes change the in-memory jobs and are appended to <stateDir>/homebase-writes.json. */
export class MockHomebase implements HomebaseClient {
  readonly kind = "mock" as const;
  jobs: JobDetail[];
  writes: MockWrite[] = [];

  constructor(private stateDir?: string, fixture = path.join(HUB_ROOT, "fixtures", "homebase-jobs.json")) {
    this.jobs = JSON.parse(readFileSync(fixture, "utf8"));
  }

  async listJobs(filter: { openOnly?: boolean } = {}) {
    const closed = new Set(["Complete", "Invoiced"]);
    return this.jobs.filter((j) => !filter.openOnly || !closed.has(j.stage)).map(({ contacts, notes, text, ...s }) => s);
  }

  async getJob(jobNumber: number) {
    const j = this.jobs.find((x) => x.jobNumber === jobNumber);
    if (!j) throw new Error(`Homebase (mock): no job #${jobNumber}`);
    return structuredClone(j);
  }

  async setProposal(jobNumber: number, p: { amount: number; submittedAt: string }) {
    if (!(p.amount > 0) || !p.submittedAt) throw new Error("setProposal needs both an amount and a submitted date");
    const j = this.find(jobNumber);
    j.proposalAmount = p.amount;
    j.proposalSubmittedAt = p.submittedAt;
    this.record(jobNumber, "setProposal", p);
  }

  async setContractAmount(jobNumber: number, amount: number) {
    this.find(jobNumber).contractAmount = amount;
    this.record(jobNumber, "setContractAmount", { amount });
  }

  async setStage(jobNumber: number, stage: string) {
    const j = this.find(jobNumber);
    j.stage = stage;
    j.stageSince = new Date().toISOString().slice(0, 10);
    this.record(jobNumber, "setStage", { stage });
  }

  async addNote(jobNumber: number, note: { kind: "note" | "call"; body: string }) {
    this.find(jobNumber).notes.push({ at: new Date().toISOString(), body: `[${note.kind}] ${note.body}` });
    this.record(jobNumber, "addNote", note);
  }

  private find(jobNumber: number) {
    const j = this.jobs.find((x) => x.jobNumber === jobNumber);
    if (!j) throw new Error(`Homebase (mock): no job #${jobNumber}`);
    return j;
  }

  private record(jobNumber: number, op: MockWrite["op"], args: unknown) {
    const w = { at: new Date().toISOString(), jobNumber, op, args };
    this.writes.push(w);
    if (!this.stateDir) return;
    mkdirSync(this.stateDir, { recursive: true });
    const file = path.join(this.stateDir, "homebase-writes.json");
    const all = existsSync(file) ? JSON.parse(readFileSync(file, "utf8")) : [];
    writeFileSync(file, JSON.stringify([...all, w], null, 2));
  }
}
