import { copyFileSync, existsSync, mkdirSync, readdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { Config } from "../../core/config.js";
import { HUB_ROOT } from "../../core/config.js";

/** CompanyCam (api.companycam.com/v2): find a job's project, list its photos, download them into the job folder. */
export interface CCProject {
  id: string;
  name: string;
  address: string;
  photoCount: number;
  url: string;
  /** CompanyCam's own viewer for the project, made to sit inside another page. */
  embedUrl?: string;
  publicUrl?: string;
}

export interface CCPhoto {
  id: string;
  capturedAt: string;
  description: string;
  creator: string;
  url: string; // CompanyCam page for the photo
  original: string; // full-size image URI
  web: string; // ~400 px
  thumb?: string; // ~250 px
}

export interface PhotoClient {
  readonly kind: "mock" | "rest";
  findProjects(query: string): Promise<CCProject[]>;
  project?(projectId: string): Promise<CCProject>;
  /** Photos stay in CompanyCam; Keystone shows them from their CompanyCam addresses. */
  listPhotos(projectId: string): Promise<CCPhoto[]>;
  /** Downloads photos into destDir as cc_<capturedAt>_<id>.jpg (skipping ones already there): only for a photo report. */
  download(photos: CCPhoto[], destDir: string, size?: "original" | "web"): Promise<string[]>;
}

/** "3226 - Augustine - 1071 Acapulco Ct - ..." is how Forefront names CompanyCam projects. */
export function pickProject(projects: CCProject[], jobNumber: number, address = ""): CCProject | undefined {
  const street = address.split(",")[0].trim().toLowerCase();
  return (
    projects.find((p) => new RegExp(`^\\s*${jobNumber}\\b`).test(p.name)) ??
    projects.find((p) => p.name.includes(String(jobNumber))) ??
    (street ? projects.find((p) => p.address.toLowerCase().includes(street) || p.name.toLowerCase().includes(street)) : undefined)
  );
}

export function photoFileName(p: CCPhoto): string {
  return `cc_${(p.capturedAt || "").slice(0, 19).replace(/[:T]/g, "-")}_${p.id}.jpg`;
}

export class RestCompanyCam implements PhotoClient {
  readonly kind = "rest" as const;
  constructor(private token: string, private fetchFn: typeof fetch = fetch) {}

  private async get<T>(p: string): Promise<T> {
    const res = await this.fetchFn(`https://api.companycam.com/v2${p}`, { headers: { Authorization: `Bearer ${this.token}`, Accept: "application/json" } });
    if (!res.ok) throw new Error(`CompanyCam GET ${p}: ${res.status} ${await res.text()}`);
    return (await res.json()) as T;
  }

  async findProjects(query: string): Promise<CCProject[]> {
    const data = await this.get<any[]>(`/projects?query=${encodeURIComponent(query)}&per_page=25`);
    return data.map(toProject);
  }

  async project(projectId: string): Promise<CCProject> {
    return toProject(await this.get<any>(`/projects/${projectId}`));
  }

  async listPhotos(projectId: string): Promise<CCPhoto[]> {
    const out: CCPhoto[] = [];
    for (let page = 1; page < 50; page++) {
      const data = await this.get<any[]>(`/projects/${projectId}/photos?per_page=100&page=${page}`);
      for (const p of data) {
        const uri = (t: string) => p.uris?.find((u: any) => u.type === t)?.uri ?? "";
        out.push({
          id: String(p.id),
          capturedAt: p.captured_at ? new Date(typeof p.captured_at === "number" ? p.captured_at * 1000 : p.captured_at).toISOString() : "",
          description: p.description ?? "",
          creator: p.creator_name ?? "",
          url: p.photo_url ?? "",
          original: uri("original"),
          web: uri("web"),
          thumb: uri("thumbnail") || uri("web"),
        });
      }
      if (data.length < 100) break;
    }
    return out.sort((a, b) => a.capturedAt.localeCompare(b.capturedAt));
  }

  async download(photos: CCPhoto[], destDir: string, size: "original" | "web" = "original"): Promise<string[]> {
    mkdirSync(destDir, { recursive: true });
    const files: string[] = [];
    for (const p of photos) {
      const file = path.join(destDir, photoFileName(p));
      if (!existsSync(file)) {
        const res = await this.fetchFn(size === "web" ? p.web || p.original : p.original || p.web);
        if (!res.ok) throw new Error(`CompanyCam photo ${p.id}: ${res.status}`);
        writeFileSync(file, Buffer.from(await res.arrayBuffer()));
      }
      files.push(file);
    }
    return files;
  }
}

function toProject(p: any): CCProject {
  return {
    id: String(p.id),
    name: p.name ?? "",
    address: [p.address?.street_address_1, p.address?.city, p.address?.state, p.address?.postal_code].filter(Boolean).join(", "),
    photoCount: p.photo_count ?? 0,
    url: p.project_url ?? `https://app.companycam.com/projects/${p.id}`,
    embedUrl: p.embedded_project_url ?? undefined,
    publicUrl: p.public_url ?? undefined,
  };
}

export class MockCompanyCam implements PhotoClient {
  readonly kind = "mock" as const;
  private dir = path.join(HUB_ROOT, "fixtures", "photos");

  async findProjects(query: string): Promise<CCProject[]> {
    const all = [
      { id: "cc-9001", name: "9001 - Sample - 123 Main St - Denver - Recon", address: "123 Main St, Denver, CO, 80211", photoCount: 5, url: "https://app.companycam.com/projects/cc-9001" },
      { id: "cc-9002", name: "9002 - Example - 45 Pine Ave - Boulder - Recon", address: "45 Pine Ave, Boulder, CO, 80302", photoCount: 5, url: "https://app.companycam.com/projects/cc-9002" },
    ];
    return all.filter((p) => `${p.name} ${p.address}`.toLowerCase().includes(query.toLowerCase()));
  }

  async listPhotos(projectId: string): Promise<CCPhoto[]> {
    const captions = ["Bathroom ceiling - drywall removed", "Bathroom wall - flood cut", "Hall - LVP cupping", "Before loss - hall", "Moisture reading"];
    return readdirSync(this.dir)
      .filter((f) => f.endsWith(".jpg"))
      .sort()
      .map((f, i) => ({
        id: `${projectId}-${i + 1}`,
        capturedAt: new Date(Date.UTC(2026, 9, 28, 16, i)).toISOString(),
        description: captions[i] ?? "",
        creator: "Mock Tech",
        url: "",
        original: path.join(this.dir, f),
        web: path.join(this.dir, f),
      }));
  }

  async download(photos: CCPhoto[], destDir: string, _size?: "original" | "web"): Promise<string[]> {
    mkdirSync(destDir, { recursive: true });
    return photos.map((p) => {
      const file = path.join(destDir, photoFileName(p));
      if (!existsSync(file)) copyFileSync(p.original, file);
      return file;
    });
  }
}

export function makeCompanyCam(cfg: Config): PhotoClient {
  return cfg.companycam.driver === "rest" ? new RestCompanyCam(cfg.companycam.token) : new MockCompanyCam();
}
