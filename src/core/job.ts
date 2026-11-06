import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { z } from "zod";

/** Homebase's stages in pipeline order (GET /api/v1/vocabulary, 2026-11-05). */
export const STAGES = [
  "Qualify", "Lead", "FDA", "Scope Walk", "Adjustment", "Estimating", "Proposal Review", "Proposal Submitted",
  "Closed Lost", "Job Won", "Waitlist", "WA/Contract Sent", "Job Prep", "Ordering Materials", "Materials Stand-by",
  "Scheduling", "Work In Progress", "Supplement", "On-Hold", "Job Complete", "Billing Prep", "Ready to Be Sent",
  "Sent To Insurance", "Invoiced", "Payment Received", "Lien/Collections",
] as const;

/** Stages that mean the proposal has gone out (or the job is past it). */
export const AT_OR_PAST_PROPOSAL = new Set<string>(STAGES.slice(STAGES.indexOf("Proposal Submitted")));

const Person = z.object({
  name: z.string().default(""),
  email: z.string().default(""),
  phone: z.string().default(""),
});

const Draft = z.object({
  id: z.string(),
  kind: z.enum(["homeowner", "adjuster", "other"]),
  to: z.array(z.string()),
  subject: z.string(),
  messageId: z.string().default(""),
  attachments: z.array(z.string()).default([]),
  createdAt: z.string(),
  sentAt: z.string().optional(),
});

export const JobSchema = z.object({
  jobNumber: z.number().int(),
  name: z.string().default(""), // usually the customer's last name
  homebaseId: z.string().default(""),
  homebaseUrl: z.string().default(""),
  address: z.string().default(""),
  market: z.string().default(""), // CODE8X (Denver metro) / COBO8X (Boulder County)
  stage: z.string().default(""),
  stageSince: z.string().default(""),
  customer: Person.default({ name: "", email: "", phone: "" }),
  adjuster: Person.default({ name: "", email: "", phone: "" }),
  carrier: z.string().default(""),
  claimNumber: z.string().default(""),
  dateOfLoss: z.string().default(""),
  insurance: z.enum(["claim", "oop", "unknown"]).default("unknown"),
  companycamProjectId: z.string().default(""),
  docusketchProjectId: z.string().default(""),
  estimate: z
    .object({
      status: z.enum(["none", "draft", "rendered", "sent"]).default("none"),
      version: z.number().int().default(0),
      total: z.number().optional(),
      files: z.array(z.string()).default([]),
      renderedAt: z.string().optional(),
    })
    .default({ status: "none", version: 0, files: [] }),
  sendoff: z
    .object({
      drafts: z.array(Draft).default([]),
      proposalAmount: z.number().optional(),
      sentAt: z.string().optional(),
      homebaseLoggedAt: z.string().optional(),
    })
    .default({ drafts: [] }),
  log: z.array(z.object({ at: z.string(), what: z.string() })).default([]),
  /** Last background sync with Homebase, and the last CompanyCam/DocuSketch look-up (those run at most daily). */
  syncedAt: z.string().default(""),
  lookupsAt: z.string().default(""),
  /** What the background sync last saw on the job, for the Today screen's reminders. */
  pulse: z
    .object({
      lastTouchAt: z.string().default(""),
      lastTouch: z.string().default(""),
      /** The newest email from someone else on the job that has no answer from Hunter after it. */
      waiting: z.object({ from: z.string(), subject: z.string(), at: z.string(), threadId: z.string().default("") }).nullable().default(null),
      proposalAmount: z.number().nullable().default(null),
      checkedAt: z.string().default(""),
    })
    .default({ lastTouchAt: "", lastTouch: "", waiting: null, proposalAmount: null, checkedAt: "" }),
});

export type Job = z.infer<typeof JobSchema>;
export type SendoffDraft = z.infer<typeof Draft>;
/** A partial job.json; nested objects merge, arrays replace, and `null` clears a field. */
export type JobPatch = { [K in keyof Job]?: Job[K] extends object ? Job[K] | { [P in keyof Job[K]]?: Job[K][P] | null } : Job[K] };

/** `homebase/` mirrors the job's Documents tab in Homebase (see workflows/files.ts). */
export const SUBDIRS = ["sketch", "photos", "estimate", "email", "notes", "homebase"] as const;

/** One folder per job number under JOBS_ROOT ("3226 Augustine"), holding job.json and the job's files. */
export class JobStore {
  constructor(readonly root: string) {}

  /** The folder for a job number: an existing "3226" / "3226 Augustine" folder, else a new one. */
  folder(jobNumber: number, name = ""): string {
    if (existsSync(this.root)) {
      const hit = readdirSync(this.root).find((d) => d === String(jobNumber) || d.startsWith(`${jobNumber} `));
      if (hit) return path.join(this.root, hit);
    }
    const clean = name.replace(/[<>:"/\\|?*]/g, "").trim();
    return path.join(this.root, clean ? `${jobNumber} ${clean}` : String(jobNumber));
  }

  exists(jobNumber: number): boolean {
    return existsSync(path.join(this.folder(jobNumber), "job.json"));
  }

  list(): Job[] {
    if (!existsSync(this.root)) return [];
    return readdirSync(this.root)
      .filter((d) => /^\d+/.test(d) && existsSync(path.join(this.root, d, "job.json")))
      .map((d) => this.get(Number.parseInt(d, 10)));
  }

  get(jobNumber: number): Job {
    const file = path.join(this.folder(jobNumber), "job.json");
    if (!existsSync(file)) throw new Error(`No job folder for #${jobNumber} under ${this.root}. Run: hub pull ${jobNumber}`);
    return JobSchema.parse(JSON.parse(readFileSync(file, "utf8")));
  }

  /** Create the folder (and subfolders) if needed, merge `patch` into job.json, and return the result. */
  upsert(jobNumber: number, patch: JobPatch): Job {
    const dir = this.folder(jobNumber, patch.name);
    for (const sub of SUBDIRS) mkdirSync(path.join(dir, sub), { recursive: true });
    const file = path.join(dir, "job.json");
    const current = existsSync(file) ? JSON.parse(readFileSync(file, "utf8")) : { jobNumber };
    const next = JobSchema.parse(deepMerge(current, { ...patch, jobNumber }));
    const tmp = `${file}.tmp`;
    writeFileSync(tmp, JSON.stringify(next, null, 2) + "\n");
    renameSync(tmp, file);
    return next;
  }

  log(jobNumber: number, what: string): void {
    const job = this.get(jobNumber);
    this.upsert(jobNumber, { log: [...job.log, { at: new Date().toISOString(), what }] });
  }

  path(jobNumber: number, ...parts: string[]): string {
    return path.join(this.folder(jobNumber), ...parts);
  }

  /** Files in a job subfolder, newest first. */
  files(jobNumber: number, sub: (typeof SUBDIRS)[number], ext?: RegExp): string[] {
    const dir = this.path(jobNumber, sub);
    if (!existsSync(dir)) return [];
    return readdirSync(dir)
      .filter((f) => !ext || ext.test(f))
      .map((f) => path.join(dir, f))
      .filter((f) => statSync(f).isFile())
      .sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs);
  }

  /** Copy estimate/*.pdf + estimate.json to estimate/revisions/vN before they are overwritten. Returns the folder. */
  snapshotEstimate(jobNumber: number): string | null {
    const files = this.files(jobNumber, "estimate", /\.(pdf|json)$/i);
    if (!files.length) return null;
    const revs = this.path(jobNumber, "estimate", "revisions");
    mkdirSync(revs, { recursive: true });
    const n = readdirSync(revs).filter((d) => /^v\d+$/.test(d)).length + 1;
    const dest = path.join(revs, `v${n}`);
    mkdirSync(dest);
    for (const f of files) cpSync(f, path.join(dest, path.basename(f)));
    return dest;
  }
}

export function lastName(full: string): string {
  const s = (full || "").trim();
  if (!s) return "";
  return s.includes(",") ? s.split(",")[0].trim() : s.split(/\s+/).at(-1)!;
}

export function firstName(full: string): string {
  const s = (full || "").trim();
  if (!s) return "";
  return s.includes(",") ? (s.split(",")[1] || "").trim().split(/\s+/)[0] : s.split(/\s+/)[0];
}

function deepMerge(a: any, b: any): any {
  if (Array.isArray(b) || typeof b !== "object" || b === null) return b === undefined ? a : b;
  const out: any = { ...(a ?? {}) };
  for (const [k, v] of Object.entries(b)) {
    if (v === undefined) continue;
    if (v === null) {
      delete out[k]; // null in a patch clears the field
      continue;
    }
    out[k] = typeof v === "object" && v !== null && !Array.isArray(v) ? deepMerge(out[k], v) : v;
  }
  return out;
}
