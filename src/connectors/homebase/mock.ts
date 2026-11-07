import { createHash } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { HUB_ROOT } from "../../core/config.js";
import type { DocumentKind, HbNote, HbPerson, HomebaseClient, HomebaseDocument, JobDetail } from "./types.js";

export interface MockWrite {
  at: string;
  jobNumber: number;
  op: "setProposal" | "setContractAmount" | "setStage" | "addNote" | "uploadDocument" | "updateFields" | "createContact" | "updateContact" | "replyNote";
  args: unknown;
}

/** Homebase on fixture data. Writes change the in-memory jobs and are appended to <stateDir>/homebase-writes.json. */
export class MockHomebase implements HomebaseClient {
  readonly kind = "mock" as const;
  jobs: JobDetail[];
  writes: MockWrite[] = [];
  /** Documents per job: the row plus where its bytes live. */
  docs = new Map<number, { doc: HomebaseDocument; file: string }[]>();

  constructor(private stateDir?: string, fixture = path.join(HUB_ROOT, "fixtures", "homebase-jobs.json")) {
    this.jobs = JSON.parse(readFileSync(fixture, "utf8"));
  }

  async listJobs(filter: { openOnly?: boolean; mine?: string } = {}) {
    const closed = new Set(["Payment Received", "Closed Lost"]);
    return this.jobs
      .filter((j) => !filter.openOnly || !closed.has(j.stage))
      .filter((j) => !filter.mine || Object.values(j.people ?? {}).includes(filter.mine))
      .map(({ contacts, notes, noteFeed, text, ...s }) => s);
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

  async setStage(jobNumber: number, stage: string, _from?: string, extra: { lossReason?: string; lossReasonOther?: string } = {}) {
    if (stage === "Closed Lost" && !extra.lossReason) throw new Error("Closed Lost needs a loss reason.");
    const j = this.find(jobNumber);
    j.stage = stage;
    j.stageSince = new Date().toISOString().slice(0, 10);
    this.record(jobNumber, "setStage", { stage });
  }

  async addNote(jobNumber: number, note: { kind: "note" | "call"; body: string }) {
    const j = this.find(jobNumber), at = new Date().toISOString();
    j.notes.push({ at, body: `[${note.kind}] ${note.body}` });
    if (note.kind === "note") (j.noteFeed ??= []).unshift({ id: `note-${Date.now()}`, body: note.body, author: "🧮 Estimating hub — Hunter Patterson", authorId: null, postedAt: at, replies: [] });
    this.record(jobNumber, "addNote", note);
  }

  async searchContacts(q: string): Promise<HbPerson[]> {
    const k = q.toLowerCase();
    return this.jobs.flatMap((j) => j.contacts).filter((c) => k.length >= 3 && `${c.name} ${c.email}`.toLowerCase().includes(k)).map((c, i) => ({ id: `mock-c-${i}-${c.email || c.name}`, name: c.name, email: c.email || undefined, phones: c.phone ? [{ number: c.phone }] : [], title: c.role === "adjuster" ? "Adjuster" : undefined }));
  }

  async noteFeed(jobNumber: number): Promise<HbNote[]> {
    return structuredClone(this.find(jobNumber).noteFeed ?? []);
  }

  async replyNote(jobNumber: number, noteId: string, body: string) {
    const n = (this.find(jobNumber).noteFeed ?? []).find((x) => x.id === noteId);
    if (!n) throw new Error("Homebase (mock): that note isn't on this job");
    n.replies.push({ id: `${noteId}-r${n.replies.length + 1}`, body, author: "🧮 Estimating hub — Hunter Patterson", authorId: null, postedAt: new Date().toISOString(), replies: [] });
    this.record(jobNumber, "replyNote", { noteId, body });
  }

  /** Editable fields set through the mock, overlaid on the fixture (shaped like the real API's job read). */
  fields = new Map<number, Record<string, unknown>>();

  async rawJob(jobNumber: number) {
    const j = this.find(jobNumber);
    const f = this.fields.get(jobNumber) ?? {};
    const cust = j.contacts.find((c) => c.role === "customer");
    const [street, city, statezip] = j.address.split(",").map((s) => s.trim());
    return {
      id: j.id,
      jobNumber: String(j.jobNumber),
      stage: j.stage,
      address: { street: street ?? "", unit: null, city: city ?? "", state: statezip?.split(" ")[0] ?? "", zip: statezip?.split(" ")[1] ?? "" },
      contacts: cust ? [{ id: `contact-${jobNumber}`, name: cust.name, email: cust.email, phone: cust.phone, roles: ["Primary"], isPrimary: true }] : [],
      brief: { claimNumber: j.claimNumber || null, carrier: j.carrier ? { id: "acct-carrier", name: j.carrier, kind: "Carrier" } : null, adjuster1: null, adjuster2: null, customerNotes: null, ...f },
      money: { proposalAmount: j.proposalAmount ?? null, proposalSubmittedOn: j.proposalSubmittedAt ?? null, contractAmount: j.contractAmount ?? null },
      people: j.people ?? {},
      ...f,
    };
  }

  async updateFields(jobNumber: number, changes: Record<string, unknown>) {
    this.find(jobNumber);
    this.fields.set(jobNumber, { ...(this.fields.get(jobNumber) ?? {}), ...changes });
    this.record(jobNumber, "updateFields", changes);
    return Object.fromEntries(Object.keys(changes).map((k) => [k, { ok: true, changed: true }]));
  }

  async createContact(jobNumber: number, c: { first: string; last: string; email?: string; phone?: string; title?: string }) {
    this.record(jobNumber, "createContact", c);
    return { id: `contact-${c.first}-${c.last}`.toLowerCase(), adopted: false };
  }

  async updateContact(contactId: string, c: Record<string, string | undefined>) {
    this.writes.push({ at: new Date().toISOString(), jobNumber: 0, op: "updateContact", args: { contactId, ...c } });
    return Object.fromEntries(Object.keys(c).map((k) => [k, { ok: true, changed: true }]));
  }

  async searchAccounts(q: string) {
    return [{ id: "acct-carrier", name: "Example Mutual", kind: "Carrier" }, { id: "acct-sf", name: "State Farm Insurance Claims", kind: "Carrier" }].filter((a) => a.name.toLowerCase().includes(q.toLowerCase()));
  }

  async suggestJobs(clues: { addresses?: string[]; numbers?: string[] }) {
    return this.jobs
      .filter((j) => (clues.numbers ?? []).includes(String(j.jobNumber)) || j.contacts.some((c) => (clues.addresses ?? []).includes(c.email)))
      .map(({ contacts, notes, text, ...s }) => s);
  }

  async vocabulary() {
    return { fundingTypes: ["Insurance", "Self-pay", "TBD", "T&M"], claimStatuses: ["Not sure", "Agent recommended inspection", "Claim filed", "Adjuster already inspected", "Out of pocket"], lossReasons: ["Never heard back", "Lost to another contractor", "We turned the job down", "Price", "Referred out", "Other"] };
  }

  async documents(jobNumber: number) {
    return (this.docs.get(jobNumber) ?? []).map((d) => ({ ...d.doc }));
  }

  async downloadDocument(doc: HomebaseDocument, dest: string) {
    const hit = [...this.docs.values()].flat().find((d) => d.doc.id === doc.id);
    if (!hit) throw new Error(`Homebase (mock): no document ${doc.id}`);
    mkdirSync(path.dirname(dest), { recursive: true });
    copyFileSync(hit.file, dest);
  }

  async uploadDocument(jobNumber: number, file: string, o: { kind: DocumentKind; title?: string }) {
    this.find(jobNumber);
    const doc = mockDoc(file, o.kind, o.title);
    this.docs.set(jobNumber, [{ doc, file }, ...(this.docs.get(jobNumber) ?? [])]);
    this.record(jobNumber, "uploadDocument", { file: path.basename(file), kind: o.kind });
    return doc;
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

export function mockDoc(file: string, kind: HomebaseDocument["kind"], title?: string): HomebaseDocument {
  const id = crypto.randomUUID();
  return {
    id,
    kind,
    title: title ?? path.basename(file),
    fileName: path.basename(file),
    mimeType: file.endsWith(".pdf") ? "application/pdf" : "application/octet-stream",
    byteSize: statSync(file).size,
    sha256: createHash("sha256").update(readFileSync(file)).digest("hex"),
    source: "homebase",
    createdAt: new Date().toISOString(),
    download: `/api/v1/documents/${id}`,
  };
}
