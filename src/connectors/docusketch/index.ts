import { copyFileSync, existsSync, mkdirSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import type { MailClient } from "../gmail/types.js";

/**
 * DocuSketch has no public API. What it does give us:
 *  - a "Sketch request for the project <id> delivered" email from help@docusketch.com, naming the project
 *    ("MAugustine - 1071 Acapulco Ct - Colorado Springs - Recon") but with no attachment, only a portal link;
 *  - ESX downloads from the portal named after the project id ("5625744v2.ESX").
 * So: find the delivery email for the job to learn the project id, then pick the ESX up from the job's sketch/
 * folder or your Downloads folder by that id. Downloading from the portal itself can come later (browser).
 */
export interface SketchDelivery {
  projectId: string;
  projectName: string;
  deliveredAt: string;
  threadId: string;
  portalUrl: string;
}

export interface SketchSource {
  findDelivery(job: { name: string; address: string }): Promise<SketchDelivery | null>;
  /** Copies the newest ESX for the project into sketchDir (unless one is already there) and returns its path. */
  fetchEsx(opts: { projectId?: string; sketchDir: string }): Promise<string | null>;
}

const SUBJECT_RE = /Sketch request for the project (\d+) delivered/i;

export function parseDeliverySubject(subject: string): string | null {
  return subject.match(SUBJECT_RE)?.[1] ?? null;
}

export class DocuSketch implements SketchSource {
  constructor(private mail: MailClient, private downloadsDir: string) {}

  async findDelivery(job: { name: string; address: string }): Promise<SketchDelivery | null> {
    const street = job.address.split(",")[0].trim();
    const terms = [street && `"${street}"`, job.name].filter(Boolean);
    for (const t of terms) {
      const hits = await this.mail.search(`from:help@docusketch.com subject:delivered ${t}`, 5);
      const hit = hits.find((h) => parseDeliverySubject(h.subject));
      if (!hit) continue;
      const thread = await this.mail.getThread(hit.id);
      const body = thread.messages[0]?.body ?? "";
      return {
        projectId: parseDeliverySubject(hit.subject)!,
        projectName: body.match(/Project name\s*\n\s*([^\n]+)/i)?.[1]?.trim() ?? "",
        deliveredAt: hit.date,
        threadId: hit.id,
        portalUrl: "https://app.docusketch.com/portal-cc/projects",
      };
    }
    return null;
  }

  async fetchEsx({ projectId, sketchDir }: { projectId?: string; sketchDir: string }): Promise<string | null> {
    const inJob = esxFiles(sketchDir).find((f) => !projectId || path.basename(f).startsWith(projectId));
    if (inJob) return inJob;
    if (!projectId) return esxFiles(sketchDir)[0] ?? null;
    const dl = esxFiles(this.downloadsDir).find((f) => path.basename(f).startsWith(projectId));
    if (!dl) return null;
    mkdirSync(sketchDir, { recursive: true });
    const dest = path.join(sketchDir, path.basename(dl));
    copyFileSync(dl, dest);
    return dest;
  }
}

function esxFiles(dir: string): string[] {
  if (!dir || !existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f) => /\.esx$/i.test(f))
    .map((f) => path.join(dir, f))
    .sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs);
}
