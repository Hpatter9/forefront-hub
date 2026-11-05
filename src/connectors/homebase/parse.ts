import { STAGES } from "../../core/job.js";
import type { Contact, JobDetail, JobSummary } from "./types.js";

/** A link on a Homebase page plus the text of the row/card it sits in. */
export interface PageLink {
  href: string;
  text: string;
  rowText: string;
}

const PROJECT_RE = /\/projects\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/i;
const JOBNO_RE = /#\s?(\d{3,6})\b/;
const EMAIL_RE = /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi;

/** Longest stage names first so "Proposal Submitted" wins over "Proposal". */
const STAGES_BY_LENGTH = [...STAGES].sort((a, b) => b.length - a.length);

export function findStage(text: string): string {
  for (const s of STAGES_BY_LENGTH) if (new RegExp(`\\b${s.replace(/[/]/g, "\\/")}\\b`, "i").test(text)) return s;
  return "";
}

export function money(text: string | undefined): number | undefined {
  if (!text) return undefined;
  const m = text.match(/\$?\s*([\d,]+(?:\.\d{1,2})?)/);
  if (!m) return undefined;
  const n = Number(m[1].replace(/,/g, ""));
  return Number.isFinite(n) ? n : undefined;
}

/** Jobs from the recon dashboard: every /projects/<uuid> link, its job number and stage from the row text. */
export function parseDashboard(links: PageLink[], baseUrl: string): JobSummary[] {
  const seen = new Map<string, JobSummary>();
  for (const l of links) {
    const id = l.href.match(PROJECT_RE)?.[1];
    if (!id || seen.has(id)) continue;
    const row = `${l.text} ${l.rowText}`.replace(/\s+/g, " ");
    const n = row.match(JOBNO_RE)?.[1];
    if (!n) continue;
    const days = row.match(/(\d+)\s*(?:d\b|days?\b)/i)?.[1];
    seen.set(id, {
      id,
      jobNumber: Number(n),
      name: l.text.replace(JOBNO_RE, "").replace(/[-–|]/g, " ").replace(/\s+/g, " ").trim(),
      address: row.match(/\d+\s+[A-Za-z0-9 .]+(?:St|Ave|Ct|Dr|Rd|Ln|Way|Blvd|Cir|Pl|Pkwy|Trl|Ter)\b[^|]*?(?:CO\s*\d{5})?/)?.[0]?.trim() ?? "",
      stage: findStage(row),
      stageSince: days ? new Date(Date.now() - Number(days) * 864e5).toISOString().slice(0, 10) : undefined,
      url: new URL(`/projects/${id}`, baseUrl).toString(),
    });
  }
  return [...seen.values()];
}

/** Best-effort read of a job page from its text and links. `text` is kept so the agent can read the rest. */
export function parseJobPage(text: string, links: PageLink[], url: string): Omit<JobDetail, "notes"> & { notes: JobDetail["notes"] } {
  const t = text.replace(/\r/g, "");
  const line = (label: RegExp) => t.match(new RegExp(`${label.source}\\s*[:\\n]\\s*([^\\n]+)`, "i"))?.[1]?.trim();

  const mailtoBcc = links
    .map((l) => l.href)
    .filter((h) => h.startsWith("mailto:"))
    .map((h) => decodeURIComponent(h).match(/bcc=([^&]+)/i)?.[1])
    .find(Boolean);
  const jobNumber = Number(t.match(JOBNO_RE)?.[1] ?? mailtoBcc?.match(/office\+(\d+)/)?.[1] ?? 0);

  const contacts: Contact[] = [];
  for (const m of t.matchAll(EMAIL_RE)) {
    const email = m[0];
    if (/forefrontteam\.com$/i.test(email) || contacts.some((c) => c.email === email)) continue;
    const before = t.slice(Math.max(0, m.index! - 160), m.index).toLowerCase();
    const role: Contact["role"] = /adjuster|claim rep|desk|field/.test(before) ? "adjuster" : /customer|homeowner|insured|owner|client/.test(before) ? "customer" : "other";
    const nameLine = t.slice(Math.max(0, m.index! - 160), m.index).split("\n").map((s) => s.trim()).filter(Boolean).at(-1) ?? "";
    contacts.push({ role, name: /@|\d{3}/.test(nameLine) ? "" : nameLine.replace(/^(customer|homeowner|adjuster|insured)\s*:?\s*/i, ""), email, phone: "" });
  }

  return {
    id: url.match(PROJECT_RE)?.[1] ?? "",
    jobNumber,
    name: (t.match(new RegExp(`#\\s?${jobNumber}\\s*[-–:]?\\s*([^\\n]+)`))?.[1] ?? "").trim(),
    address: line(/(?:Property|Address|Loss address)/) ?? "",
    stage: findStage(line(/Stage/) ?? "") || findStage(t.slice(0, 600)),
    url,
    contacts,
    carrier: line(/(?:Carrier|Insurance(?: company)?)/) ?? "",
    claimNumber: line(/Claim(?:\s*(?:#|No\.?|Number))?/) ?? "",
    proposalAmount: money(line(/Proposal(?:\s*amount)?/)),
    proposalSubmittedAt: line(/Proposal submitted(?:\s*date)?/),
    contractAmount: money(line(/Contract(?:\s*amount)?/)),
    intakeEmail: mailtoBcc ?? (jobNumber ? `office+${jobNumber}@forefrontteam.com` : ""),
    notes: [],
    text: t,
  };
}
