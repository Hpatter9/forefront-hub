import type { Job } from "../core/job.js";

/**
 * The two judgment calls in a send-off: the email text (Hunter's voice, per the skill's step 6) and which photos
 * go in the adjuster's photo report. The live writer is the Claude agent running the forefront-estimate skill
 * (src/agent/writer.ts); TemplateWriter is a plain fallback for mock mode and tests.
 */
export type Recipient = "homeowner" | "adjuster";

export interface EmailContext {
  job: Job;
  kind: Recipient;
  total?: number; // customer total (Reconstruction Estimate) for homeowners
  xactimateTotal?: number;
  attachments: string[]; // file names
  priceList?: string;
}

export interface PhotoInfo {
  file: string;
  description: string;
  capturedAt: string;
}

export interface Pick {
  file: string;
  caption: string;
  room?: string;
}

export interface EmailWriter {
  writeEmail(ctx: EmailContext): Promise<{ subject: string; body: string }>;
  pickPhotos(job: Job, photos: PhotoInfo[], photosDir: string): Promise<Pick[]>;
}

const usd = (n?: number) => (n === undefined ? "$—" : `$${n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`);

export class TemplateWriter implements EmailWriter {
  async writeEmail({ job, kind, total }: EmailContext) {
    const street = job.address.split(",")[0];
    if (kind === "homeowner") {
      // A management company: greet the person there, else nobody by name ("Hi Westwind," reads wrong).
      const who = job.customer.company ? job.customer.attention : job.customer.name;
      const first = who.split(/\s+/)[0] || "there";
      return {
        subject: `Your Reconstruction Estimate – ${street}`,
        body: [
          `Hi ${first},`,
          `Thank you for the opportunity to help with your home. Attached is the reconstruction estimate for ${street}. It breaks the work down by trade so you can see exactly what's included, and the total comes to ${usd(total)}.`,
          "Take a look when you get a chance and let me know if you have any questions or want to talk through anything. If everything looks good, let me know and I'll move things forward on my end!",
          "Thanks again,",
        ].join("\n\n"),
      };
    }
    const first = job.adjuster.name.split(/\s+/)[0] || "there";
    return {
      subject: `${job.name} – ${street} – Repair Estimate${job.claimNumber ? ` – Claim ${job.claimNumber}` : ""}`,
      body: [
        `Hi ${first},`,
        `Attached is our repair estimate and photo report for ${job.customer.name || job.name} at ${job.address}${job.claimNumber ? ` (claim ${job.claimNumber})` : ""}.`,
        "Please review and let me know if you have any questions, or give me a call if it's easier to talk through.",
        "Thanks,",
      ].join("\n\n"),
    };
  }

  async pickPhotos(_job: Job, photos: PhotoInfo[]) {
    return photos.slice(0, 12).map((p) => ({ file: p.file, caption: p.description || "Site photo" }));
  }
}
