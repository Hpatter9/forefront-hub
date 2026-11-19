import { copyFileSync, createReadStream, createWriteStream, existsSync, mkdirSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { pipeline } from "node:stream/promises";
import { google } from "googleapis";
import type { Config } from "../../core/config.js";
import { GoogleAuth, SCOPES } from "../google/auth.js";

/**
 * Google Drive, used for one thing: the hand-off folder where Keystone leaves a job's package for Claude (in a
 * Claude chat, on Hunter's subscription) and picks up what Claude made. Keystone only touches that folder.
 */
export interface DriveFile { id: string; name: string; mimeType: string; modifiedTime: string; size?: number }
export const FOLDER = "application/vnd.google-apps.folder";
export interface DriveClient {
  readonly kind: "google" | "mock";
  connected(): boolean;
  /** A folder by exact name: inside `parentId`, or anywhere Keystone can see (including folders shared with it). */
  findFolder(name: string, parentId?: string): Promise<DriveFile | null>;
  ensureFolder(name: string, parentId: string): Promise<DriveFile>;
  list(parentId: string): Promise<DriveFile[]>;
  /** Uploads a local file into the folder, replacing a file of the same name there. */
  upload(parentId: string, file: string, name?: string): Promise<DriveFile>;
  download(fileId: string, dest: string): Promise<void>;
  remove(fileId: string): Promise<void>;
}

const MIME: Record<string, string> = { ".pdf": "application/pdf", ".json": "application/json", ".md": "text/markdown", ".txt": "text/plain", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".png": "image/png", ".esx": "application/octet-stream", ".csv": "text/csv" };
export const mimeOf = (name: string) => MIME[path.extname(name).toLowerCase()] ?? "application/octet-stream";
const q = (s: string) => s.replace(/\\/g, "\\\\").replace(/'/g, "\\'");

export class GoogleDrive implements DriveClient {
  readonly kind = "google" as const;
  constructor(private auth: GoogleAuth) {}
  private api() { return google.drive({ version: "v3", auth: this.auth.client() }); }
  connected() { return this.auth.hasScope(SCOPES.drive); }

  private static file(f: any): DriveFile {
    return { id: f.id, name: f.name, mimeType: f.mimeType, modifiedTime: f.modifiedTime ?? "", size: f.size ? Number(f.size) : undefined };
  }

  async findFolder(name: string, parentId?: string) {
    const r = await this.api().files.list({ q: `name = '${q(name)}' and mimeType = '${FOLDER}' and trashed = false${parentId ? ` and '${q(parentId)}' in parents` : ""}`, fields: "files(id,name,mimeType,modifiedTime)", pageSize: 10, supportsAllDrives: true, includeItemsFromAllDrives: true });
    const f = r.data.files?.[0];
    return f ? GoogleDrive.file(f) : null;
  }

  async ensureFolder(name: string, parentId: string) {
    const hit = await this.findFolder(name, parentId);
    if (hit) return hit;
    const r = await this.api().files.create({ requestBody: { name, mimeType: FOLDER, parents: [parentId] }, fields: "id,name,mimeType,modifiedTime", supportsAllDrives: true });
    return GoogleDrive.file(r.data);
  }

  async list(parentId: string) {
    const out: DriveFile[] = [];
    let pageToken: string | undefined;
    do {
      const r = await this.api().files.list({ q: `'${q(parentId)}' in parents and trashed = false`, fields: "nextPageToken,files(id,name,mimeType,modifiedTime,size)", pageSize: 200, pageToken, supportsAllDrives: true, includeItemsFromAllDrives: true });
      out.push(...(r.data.files ?? []).map(GoogleDrive.file));
      pageToken = r.data.nextPageToken ?? undefined;
    } while (pageToken);
    return out;
  }

  async upload(parentId: string, file: string, name = path.basename(file)) {
    const old = (await this.list(parentId)).filter((f) => f.name === name && f.mimeType !== FOLDER);
    const media = { mimeType: mimeOf(name), body: createReadStream(file) };
    const fields = "id,name,mimeType,modifiedTime,size";
    // Replace in place when Keystone can (a file it put there); otherwise add the new one.
    if (old[0]) {
      try {
        const r = await this.api().files.update({ fileId: old[0].id, media, fields, supportsAllDrives: true });
        return GoogleDrive.file(r.data);
      } catch { /* not ours to change: fall through and add */ }
    }
    const r = await this.api().files.create({ requestBody: { name, parents: [parentId] }, media: { mimeType: mimeOf(name), body: createReadStream(file) }, fields, supportsAllDrives: true });
    return GoogleDrive.file(r.data);
  }

  async download(fileId: string, dest: string) {
    mkdirSync(path.dirname(dest), { recursive: true });
    const r = await this.api().files.get({ fileId, alt: "media", supportsAllDrives: true }, { responseType: "stream" });
    await pipeline(r.data as NodeJS.ReadableStream, createWriteStream(dest));
  }

  async remove(fileId: string) {
    await this.api().files.update({ fileId, requestBody: { trashed: true }, supportsAllDrives: true });
  }
}

/** For tests and mock mode: a Drive made of folders on disk (ids are paths relative to its root). */
export class MockDrive implements DriveClient {
  readonly kind = "mock" as const;
  on = true;
  constructor(private root: string) { mkdirSync(root, { recursive: true }); }
  private p(id: string) { return path.join(this.root, id); }
  private file(id: string): DriveFile {
    const st = statSync(this.p(id));
    return { id, name: path.basename(id), mimeType: st.isDirectory() ? FOLDER : mimeOf(id), modifiedTime: st.mtime.toISOString(), size: st.size };
  }
  connected() { return this.on; }
  async findFolder(name: string, parentId = "") {
    const id = path.posix.join(parentId, name);
    return existsSync(this.p(id)) && statSync(this.p(id)).isDirectory() ? this.file(id) : null;
  }
  async ensureFolder(name: string, parentId: string) {
    const id = path.posix.join(parentId, name);
    mkdirSync(this.p(id), { recursive: true });
    return this.file(id);
  }
  async list(parentId: string) {
    return existsSync(this.p(parentId)) ? readdirSync(this.p(parentId)).map((n) => this.file(path.posix.join(parentId, n))) : [];
  }
  async upload(parentId: string, file: string, name = path.basename(file)) {
    const id = path.posix.join(parentId, name);
    mkdirSync(this.p(parentId), { recursive: true });
    copyFileSync(file, this.p(id));
    return this.file(id);
  }
  async download(fileId: string, dest: string) {
    mkdirSync(path.dirname(dest), { recursive: true });
    copyFileSync(this.p(fileId), dest);
  }
  async remove(fileId: string) {
    const { rmSync } = await import("node:fs");
    rmSync(this.p(fileId), { recursive: true, force: true });
  }
}

export function makeDrive(cfg: Config): DriveClient {
  if (cfg.gmail.driver === "google") return new GoogleDrive(new GoogleAuth({ clientId: cfg.gmail.clientId, clientSecret: cfg.gmail.clientSecret, tokenFile: cfg.gmail.tokenFile, address: cfg.gmail.address }));
  return new MockDrive(path.join(cfg.stateDir, "mock-drive"));
}
