import type { ActivityRow, Contact, DocumentKind, FieldResult, FiledEmail, HbNote, HbPerson, HomebaseClient, HomebaseDocument, JobDetail, JobSummary } from "./types.js";

/**
 * Homebase over its real JSON API (https://homebase.forefrontteam.com/api/v1, reference at /api/v1/docs).
 *
 * - Auth: the key as `Authorization: Bearer hbk_...` (the API also takes `X-Homebase-Key`), and
 *   `X-Acting-User-Email` so every write is stamped as Hunter.
 * - Writes send an `Idempotency-Key`, so a retried request never lands twice.
 * - `PATCH /projects/:id {proposalAmount}` stamps the proposal submitted date as the day of the write; Homebase
 *   takes no date. So the proposal is logged on the day it is sent (`hub sync`).
 * - Stage moves send `fromStage`, so a job someone else moved meanwhile is refused (409) instead of overwritten.
 */
export const NOTE_PREFIX = "🧮 Estimating hub";

export class ApiHomebase implements HomebaseClient {
  readonly kind = "api" as const;
  private ids = new Map<number, string>();

  constructor(private opts: { url: string; token: string; actingEmail?: string; fetch?: typeof fetch }) {}

  private async call<T>(method: string, path: string, body?: unknown, idemKey?: string): Promise<T> {
    const headers: Record<string, string> = { Accept: "application/json" };
    if (this.opts.token) headers.Authorization = `Bearer ${this.opts.token}`;
    if (this.opts.actingEmail) headers["X-Acting-User-Email"] = this.opts.actingEmail;
    if (body !== undefined) headers["Content-Type"] = "application/json";
    if (method !== "GET") headers["Idempotency-Key"] = idemKey ?? `hub:${crypto.randomUUID()}`;
    const res = await (this.opts.fetch ?? fetch)(`${this.opts.url}/api/v1${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
    const json: any = await res.json().catch(() => ({}));
    if (!res.ok || json.ok === false) {
      const e = json.error ?? {};
      throw new HomebaseError(`Homebase ${method} ${path}: ${res.status} ${e.code ?? ""} ${e.message ?? ""}`.trim(), res.status, e.code, json);
    }
    return json as T;
  }

  /** The 26 stage names in pipeline order, from Homebase itself. */
  async stages(): Promise<string[]> {
    return (await this.call<{ stages: string[] }>("GET", "/vocabulary")).stages;
  }

  async listJobs(filter: { openOnly?: boolean; mine?: string; details?: boolean } = {}): Promise<JobSummary[]> {
    const rows: any[] = [];
    for (let offset = 0; ; offset += 200) {
      const q = new URLSearchParams({ department: "reconstruction", active: filter.openOnly === false ? "0" : "1", limit: "200", offset: String(offset) });
      const page = await this.call<{ projects: any[]; more: boolean }>("GET", `/projects?${q}`);
      rows.push(...page.projects);
      if (!page.more) break;
    }
    for (const r of rows) this.ids.set(Number(r.jobNumber), r.id);
    let jobs = rows.filter((r) => /^\d+$/.test(String(r.jobNumber))).map(toSummary(this.opts.url));
    if (filter.details || filter.mine) {
      // Days in stage and the estimator are on the job read only; 55-odd jobs, 8 at a time.
      const detail = await pool(jobs, 8, (j) => this.project(j.id));
      jobs = jobs.map((j, i) => ({
        ...j,
        stageSince: detail[i]?.dates?.stageChanged ?? undefined,
        people: detail[i]?.people ? { estimator: detail[i].people.estimator ?? "", projectManager: detail[i].people.projectManager ?? "", owner: detail[i].people.owner ?? "" } : j.people,
        proposalAmount: detail[i]?.money?.proposalAmount ?? undefined,
      }));
      if (filter.mine) {
        const me = filter.mine.toLowerCase();
        jobs = jobs.filter((j) => Object.values(j.people ?? {}).some((p) => (p ?? "").toLowerCase() === me));
      }
    }
    return jobs;
  }

  /** GET /projects/:id answers { ok, project: {...} }. */
  private async project(id: string): Promise<any> {
    const r = await this.call<any>("GET", `/projects/${id}`);
    return r.project ?? r;
  }

  async projectId(jobNumber: number): Promise<string> {
    const known = this.ids.get(jobNumber);
    if (known) return known;
    const { projects } = await this.call<{ projects: any[] }>("GET", `/projects?q=${jobNumber}&active=1&limit=20`);
    let hit = projects.find((p) => Number(p.jobNumber) === jobNumber);
    if (!hit) {
      const closed = await this.call<{ projects: any[] }>("GET", `/projects?q=${jobNumber}&active=0&limit=20`);
      hit = closed.projects.find((p) => Number(p.jobNumber) === jobNumber);
    }
    if (!hit) throw new Error(`Homebase has no job #${jobNumber}`);
    this.ids.set(jobNumber, hit.id);
    return hit.id;
  }

  async getJob(jobNumber: number): Promise<JobDetail> {
    const id = await this.projectId(jobNumber);
    const p = await this.project(id);
    const contacts: Contact[] = (p.contacts ?? []).map((c: any) => ({
      role: c.isPrimary || (c.roles ?? []).includes("Primary") ? "customer" : (c.roles ?? []).some((r: string) => /adjuster/i.test(r)) ? "adjuster" : "other",
      name: c.name ?? "",
      email: c.email ?? "",
      phone: c.phone ?? c.mobile ?? "",
      id: c.id ?? undefined,
      title: c.title ?? undefined,
      company: c.accountName ?? undefined,
      accountId: c.accountId ?? undefined,
      roles: Array.isArray(c.roles) ? c.roles : undefined,
    }));
    const acct = jobAccount(p);
    for (const a of [p.brief?.adjuster1, p.brief?.adjuster2]) {
      if (a && typeof a === "object" && !contacts.some((c) => c.email && c.email === a.email)) {
        contacts.push({ role: "adjuster", name: a.name ?? "", email: a.email ?? "", phone: a.phone ?? a.mobile ?? "" });
      }
    }
    const notes = await this.call<{ notes: any[] }>("GET", `/projects/${id}/notes`).then((r) => r.notes).catch(() => []);
    return {
      ...toSummary(this.opts.url)(p),
      stageSince: p.dates?.stageChanged ?? undefined,
      contacts,
      account: acct?.name
        ? { id: acct.id ?? undefined, name: acct.name, subtype: acct.subtype ?? undefined, propertyManager: !!acct.isPropertyManager || /property manag|\bhoa\b|homeowners? association/i.test(acct.subtype ?? ""), billingEmail: acct.billingEmail ?? undefined, phone: acct.phone ?? undefined }
        : undefined,
      carrier: typeof p.brief?.carrier === "object" && p.brief?.carrier ? p.brief.carrier.name ?? "" : p.brief?.carrier ?? "",
      claimNumber: p.brief?.claimNumber ?? "",
      dateOfLoss: p.dateOfLoss ?? undefined,
      proposalAmount: p.money?.proposalAmount ?? undefined,
      proposalSubmittedAt: p.money?.proposalSubmittedOn ?? undefined,
      contractAmount: p.money?.contractAmount ?? undefined,
      intakeEmail: `office+${jobNumber}@forefrontteam.com`,
      notes: notes.map((n: any) => ({ at: n.postedAt, body: `${n.author ? `${n.author}: ` : ""}${n.body}` })),
      noteFeed: notes.map(toNote),
      picturesLink: p.brief?.picturesLink ?? p.picturesLink ?? undefined,
    };
  }

  async setProposal(jobNumber: number, p: { amount: number; submittedAt: string }) {
    if (!(p.amount > 0)) throw new Error("setProposal needs an amount");
    const id = await this.projectId(jobNumber);
    // Homebase stamps the submitted date itself (the day of this write); see the class comment.
    const r = await this.call<any>("PATCH", `/projects/${id}`, { proposalAmount: p.amount.toFixed(2) }, `hub:proposal:${id}:${p.amount.toFixed(2)}:${p.submittedAt}`);
    fieldResult(r, "proposalAmount");
  }

  async setContractAmount(jobNumber: number, amount: number) {
    const id = await this.projectId(jobNumber);
    const r = await this.call<any>("PATCH", `/projects/${id}`, { contractAmount: amount.toFixed(2) });
    fieldResult(r, "contractAmount");
  }

  /** Closed Lost needs a lossReason from the vocabulary's lossReasons (or "Other" with lossReasonOther). */
  async setStage(jobNumber: number, stage: string, fromStage?: string, extra: { lossReason?: string; lossReasonOther?: string } = {}) {
    const id = await this.projectId(jobNumber);
    const from = fromStage ?? (await this.project(id)).stage;
    const reason = stage === "Closed Lost" ? { lossReason: extra.lossReason, ...(extra.lossReason === "Other" ? { lossReasonOther: extra.lossReasonOther } : {}) } : {};
    await this.call("PATCH", `/projects/${id}/stage`, { stage, fromStage: from, ...reason }, `hub:stage:${id}:${from}->${stage}`);
  }

  async addNote(jobNumber: number, note: { kind: "note" | "call"; body: string; who?: string; direction?: "Inbound" | "Outbound" }) {
    const id = await this.projectId(jobNumber);
    if (note.kind === "call") {
      const [subject, ...rest] = note.body.split("\n");
      await this.call("POST", `/projects/${id}/activity`, { kind: "call", direction: note.direction ?? "Outbound", who: note.who, subject: subject.slice(0, 250), details: rest.join("\n") || undefined });
    } else {
      await this.call("POST", `/projects/${id}/notes`, { body: note.body, prefix: NOTE_PREFIX });
    }
  }

  async noteFeed(jobNumber: number): Promise<HbNote[]> {
    const id = await this.projectId(jobNumber);
    return (await this.call<{ notes: any[] }>("GET", `/projects/${id}/notes`)).notes.map(toNote);
  }

  async replyNote(jobNumber: number, noteId: string, body: string) {
    const id = await this.projectId(jobNumber);
    await this.call("POST", `/projects/${id}/notes/${noteId}/replies`, { body, prefix: NOTE_PREFIX });
  }

  /** Emails Homebase has filed on the job (metadata only), newest first. */
  async emails(jobNumber: number): Promise<FiledEmail[]> {
    const id = await this.projectId(jobNumber);
    return (await this.call<{ emails: FiledEmail[] }>("GET", `/projects/${id}/emails`)).emails;
  }

  async activity(jobNumber: number): Promise<ActivityRow[]> {
    const id = await this.projectId(jobNumber);
    return (await this.call<{ activity: ActivityRow[] }>("GET", `/projects/${id}/activity`)).activity;
  }

  async searchContacts(q: string): Promise<HbPerson[]> {
    if (q.trim().length < 3) return [];
    const r = await this.call<{ contacts: any[] }>("GET", `/contacts?${new URLSearchParams({ q: q.trim() })}`);
    return (r.contacts ?? []).map((c) => ({
      id: String(c.id),
      name: c.name ?? "",
      title: c.title ?? undefined,
      email: c.email ?? undefined,
      company: c.accountName ?? undefined,
      phones: (c.phones?.length ? c.phones : [{ number: c.phone }, { number: c.mobile, label: "mobile" }]).filter((x: any) => x?.number && String(x.number).replace(/\D/g, "").length >= 7).map((x: any) => ({ number: String(x.number), label: x.label ?? undefined })),
    }));
  }

  async rawJob(jobNumber: number): Promise<Record<string, any>> {
    return this.project(await this.projectId(jobNumber));
  }

  async updateFields(jobNumber: number, changes: Record<string, unknown>): Promise<Record<string, FieldResult>> {
    const id = await this.projectId(jobNumber);
    const r = await this.call<{ results?: Record<string, FieldResult> }>("PATCH", `/projects/${id}`, changes);
    return r.results ?? {};
  }

  async createContact(jobNumber: number, c: { first: string; last: string; email?: string; phone?: string; title?: string }) {
    const projectId = await this.projectId(jobNumber);
    const r = await this.call<any>("POST", `/contacts`, { ...c, projectId });
    return { id: r.contact?.id as string, adopted: !!r.adopted, ignored: r.ignored };
  }

  async updateContact(contactId: string, c: Record<string, string | undefined>): Promise<Record<string, FieldResult>> {
    const body = Object.fromEntries(Object.entries(c).filter(([, v]) => v !== undefined));
    const r = await this.call<{ results?: Record<string, FieldResult> }>("PATCH", `/contacts/${contactId}`, body);
    return r.results ?? {};
  }

  async searchAccounts(q: string, kind?: string) {
    const params = new URLSearchParams({ q, limit: "20", ...(kind ? { kind } : {}) });
    const r = await this.call<{ accounts: any[] }>("GET", `/accounts?${params}`);
    return r.accounts.map((a) => ({ id: a.id as string, name: a.name as string, kind: a.kind as string }));
  }

  async suggestJobs(clues: { addresses?: string[]; numbers?: string[]; streets?: string[]; claims?: string[] }) {
    const r = await this.call<{ projects: any[] }>("POST", "/projects/suggest", clues, `hub:suggest:${crypto.randomUUID()}`);
    return r.projects.map(toSummary(this.opts.url));
  }

  private vocab?: Record<string, any>;
  async vocabulary() {
    this.vocab ??= await this.call<Record<string, any>>("GET", "/vocabulary");
    return this.vocab;
  }

  async documents(jobNumber: number): Promise<HomebaseDocument[]> {
    const id = await this.projectId(jobNumber);
    return (await this.call<{ documents: HomebaseDocument[] }>("GET", `/projects/${id}/documents`)).documents;
  }

  async downloadDocument(doc: HomebaseDocument, dest: string): Promise<void> {
    const { writeFile, mkdir } = await import("node:fs/promises");
    const path = await import("node:path");
    const headers: Record<string, string> = {};
    if (this.opts.token) headers.Authorization = `Bearer ${this.opts.token}`;
    const res = await (this.opts.fetch ?? fetch)(`${this.opts.url}${doc.download || `/api/v1/documents/${doc.id}`}`, { headers });
    if (!res.ok) throw new HomebaseError(`Homebase download ${doc.fileName}: ${res.status}`, res.status);
    await mkdir(path.dirname(dest), { recursive: true });
    await writeFile(dest, Buffer.from(await res.arrayBuffer()));
  }

  /** Adds a file to the job's Documents tab (estimate PDFs, photo report). */
  async uploadDocument(jobNumber: number, file: string, o: { kind: DocumentKind; title?: string; version?: number }): Promise<HomebaseDocument> {
    const { readFile } = await import("node:fs/promises");
    const { createHash } = await import("node:crypto");
    const path = await import("node:path");
    const id = await this.projectId(jobNumber);
    const bytes = await readFile(file);
    const form = new FormData();
    form.append("file", new Blob([bytes], { type: file.toLowerCase().endsWith(".pdf") ? "application/pdf" : "application/octet-stream" }), path.basename(file));
    form.append("kind", o.kind);
    if (o.title) form.append("title", o.title);
    if (o.version) form.append("version", String(o.version));
    // Keyed on the content, so a retry never uploads the same file twice but a changed file goes up.
    const headers: Record<string, string> = { "Idempotency-Key": `hub:doc:${id}:${createHash("sha256").update(bytes).digest("hex")}` };
    if (this.opts.token) headers.Authorization = `Bearer ${this.opts.token}`;
    if (this.opts.actingEmail) headers["X-Acting-User-Email"] = this.opts.actingEmail;
    const res = await (this.opts.fetch ?? fetch)(`${this.opts.url}/api/v1/projects/${id}/documents`, { method: "POST", headers, body: form });
    const json: any = await res.json().catch(() => ({}));
    if (!res.ok || json.ok === false) throw new HomebaseError(`Homebase upload: ${res.status} ${json.error?.message ?? ""}`, res.status, json.error?.code, json);
    return json.document;
  }
}

export class HomebaseError extends Error {
  constructor(message: string, readonly status: number, readonly code?: string, readonly body?: unknown) {
    super(message);
  }
}

function fieldResult(r: any, field: string) {
  const f = r?.results?.[field];
  if (f && f.ok === false) throw new HomebaseError(`Homebase refused ${field}: ${f.code ?? ""} ${f.message ?? ""}`.trim(), 422, f.code, r);
}

const PM_RX = /property manag|\bmanagement\b|\bhoa\b|homeowners? association|\bpm\b/i;
/**
 * The company a job is for. Homebase's account field, else (it's often left empty) a property manager the job's
 * contacts belong to: the referral account when someone on the job works there, or the primary contact's company
 * when its name says it's a management company or HOA.
 */
export function jobAccount(p: any): any | null {
  if (p.account && typeof p.account === "object" && p.account.name) return p.account;
  const contacts: any[] = p.contacts ?? [];
  const ref = p.referral?.account;
  if (ref?.name && (ref.isPropertyManager || PM_RX.test(ref.subtype ?? "")) && contacts.some((c) => (ref.id && c.accountId === ref.id) || (c.accountName ?? "").toLowerCase() === ref.name.toLowerCase())) {
    return { ...ref, isPropertyManager: true };
  }
  const primaryCo = contacts.find((c) => c.isPrimary)?.accountName;
  if (primaryCo && PM_RX.test(primaryCo) && !/claim|risk|waste|insurance/i.test(primaryCo)) return { name: primaryCo, id: contacts.find((c) => c.isPrimary)?.accountId, isPropertyManager: true, subtype: "Property manager (from the contact's company)" };
  return null;
}

function toSummary(base: string) {
  return (p: any): JobSummary => ({
    id: p.id,
    jobNumber: Number(p.jobNumber),
    name: p.customer ?? String(p.name ?? "").split(" - ")[0],
    address: [p.address?.street, p.address?.unit, p.address?.city, [p.address?.state, p.address?.zip].filter(Boolean).join(" ")].filter(Boolean).join(", "),
    stage: p.stage ?? "",
    lastActivityAt: p.modifiedAt ?? undefined,
    url: `${base}/projects/${p.id}`,
    people: { estimator: p.people?.estimator ?? "", projectManager: p.projectManager ?? p.people?.projectManager ?? "", owner: p.owner ?? p.people?.owner ?? "" },
  });
}

async function pool<T, R>(items: T[], n: number, fn: (t: T) => Promise<R>): Promise<(R | undefined)[]> {
  const out: (R | undefined)[] = new Array(items.length);
  let i = 0;
  await Promise.all(
    Array.from({ length: Math.min(n, items.length) }, async () => {
      while (i < items.length) {
        const k = i++;
        out[k] = await fn(items[k]).catch(() => undefined);
      }
    }),
  );
  return out;
}

function toNote(n: any): HbNote {
  return { id: String(n.id), body: String(n.body ?? ""), author: String(n.author ?? ""), authorId: n.authorId ?? null, postedAt: String(n.postedAt ?? ""), replies: (n.replies ?? []).map(toNote) };
}
