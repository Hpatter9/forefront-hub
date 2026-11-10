import { existsSync, openSync, readSync, closeSync, mkdtempSync, readdirSync, rmSync, statSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import type { Config } from "../../core/config.js";

/**
 * Text messages (SMS and iMessage) from Hunter's iPhone. Apple gives no live access to texts on Windows, so the
 * live version reads the phone's own backup on this PC (made by the Apple Devices app or iTunes, over a cable or
 * Wi-Fi): the backup holds the Messages database. Read-only; nothing is ever written to the backup or the phone.
 * An encrypted backup (work-managed phones force that) is read with the backup password; it's as fresh as the last
 * backup either way.
 */
export interface TextMessage {
  id: string;
  /** The other person's phone number or iMessage address, as the phone has it. */
  handle: string;
  fromMe: boolean;
  at: string; // ISO
  text: string;
}

export interface TextsStatus {
  connected: boolean;
  /** Why not, in plain words. */
  problem?: string;
  backupAt?: string;
  backupDir?: string;
  /** The backup is encrypted (read with the backup password). */
  encrypted?: boolean;
}

export interface TextsClient {
  readonly kind: "mock" | "iphone-backup" | "off";
  status(): TextsStatus;
  /** Messages since a date, newest first. */
  messages(since: Date): Promise<TextMessage[]>;
}

/** Where the Messages database sits in an iPhone backup: sha1("HomeDomain-Library/SMS/sms.db"). */
const SMS_DB = "3d0d7e5fb2ce288813306e4d4636395e047a3d28";
const APPLE_EPOCH = 978307200; // seconds from 1970 to 2001

export function backupRoots(env: NodeJS.ProcessEnv = process.env): string[] {
  const home = env.USERPROFILE || env.HOME || os.homedir();
  return [
    path.join(home, "Apple", "MobileSync", "Backup"), // Apple Devices app (Microsoft Store)
    path.join(env.APPDATA || path.join(home, "AppData", "Roaming"), "Apple Computer", "MobileSync", "Backup"), // iTunes
    path.join(home, "Library", "Application Support", "MobileSync", "Backup"), // a Mac
  ];
}

/** The newest iPhone backup folder on this computer (or the one IPHONE_BACKUP_DIR names). */
export function findBackup(dir?: string, env: NodeJS.ProcessEnv = process.env): { dir: string; at: Date } | null {
  const candidates: { dir: string; at: Date }[] = [];
  const look = (d: string) => {
    const m = path.join(d, "Manifest.db");
    if (existsSync(m)) candidates.push({ dir: d, at: statSync(m).mtime });
  };
  if (dir) {
    look(dir);
    if (!candidates.length && existsSync(dir)) for (const x of readdirSync(dir)) look(path.join(dir, x));
  } else {
    for (const root of backupRoots(env)) if (existsSync(root)) for (const x of readdirSync(root)) look(path.join(root, x));
  }
  return candidates.sort((a, b) => b.at.getTime() - a.at.getTime())[0] ?? null;
}

const isSqlite = (file: string) => {
  const fd = openSync(file, "r");
  try {
    const b = Buffer.alloc(15);
    readSync(fd, b, 0, 15, 0);
    return b.toString("latin1") === "SQLite format 3";
  } finally {
    closeSync(fd);
  }
};

/**
 * Newer iPhones keep a message's words in `attributedBody` (Apple's typedstream) and leave `text` empty. The words
 * are the first string after the NSString marker: a "+" then the length (1 byte, or 0x81 + 2 bytes, 0x82 + 4).
 */
export function textFromAttributedBody(b: Uint8Array | null | undefined): string {
  if (!b?.length) return "";
  const buf = Buffer.from(b);
  let i = buf.indexOf("NSString");
  if (i < 0) return "";
  i = buf.indexOf(0x2b, i + 8);
  if (i < 0 || i + 1 >= buf.length) return "";
  let len = buf[i + 1];
  let start = i + 2;
  if (len === 0x81) { len = buf.readUInt16LE(i + 2); start = i + 4; }
  else if (len === 0x82) { len = buf.readUInt32LE(i + 2); start = i + 6; }
  return buf.subarray(start, Math.min(buf.length, start + len)).toString("utf8").replace(/￼/g, "").trim();
}

export class IphoneBackupTexts implements TextsClient {
  readonly kind = "iphone-backup" as const;
  /** The unlocked keys of an encrypted backup, kept while the backup doesn't change (unlocking takes seconds). */
  private keys: { kb?: import("./backupCrypto.js").Keybag; stamp?: string } = {};
  constructor(private dir?: string, private password = "") {}

  status(): TextsStatus {
    const b = findBackup(this.dir);
    if (!b) return { connected: false, problem: "No iPhone backup on this PC yet. Plug the iPhone in, open Apple Devices, and click Back Up Now." };
    if (!isSqlite(path.join(b.dir, "Manifest.db"))) {
      // Encrypted: fine with the backup password (files can't be checked without unlocking, which messages() does).
      if (this.password) return { connected: true, encrypted: true, backupDir: b.dir, backupAt: b.at.toISOString() };
      return { connected: false, encrypted: true, backupDir: b.dir, backupAt: b.at.toISOString(), problem: "The iPhone backup is encrypted. Double-click Connect iPhone texts and type the backup password (or uncheck \"Encrypt local backup\" in Apple Devices and back up again)." };
    }
    const db = path.join(b.dir, SMS_DB.slice(0, 2), SMS_DB);
    if (!existsSync(db)) return { connected: false, backupDir: b.dir, backupAt: b.at.toISOString(), problem: "That backup has no Messages in it yet. Click Back Up Now in Apple Devices and let it finish." };
    return { connected: true, backupDir: b.dir, backupAt: statSync(db).mtime.toISOString() };
  }

  async messages(since: Date): Promise<TextMessage[]> {
    const st = this.status();
    if (!st.connected) throw new Error(st.problem);
    let sqlite: typeof import("node:sqlite");
    try {
      sqlite = await import("node:sqlite");
    } catch {
      throw new Error("Reading the iPhone backup needs a newer Node.js (22.13 or later). Run Setup again to update it.");
    }
    // An encrypted backup: the Messages database is decrypted into a temporary folder, read, and deleted again.
    let tmp = "";
    let file = path.join(st.backupDir!, SMS_DB.slice(0, 2), SMS_DB);
    if (st.encrypted) {
      const { decryptBackupFile } = await import("./backupCrypto.js");
      tmp = mkdtempSync(path.join(os.tmpdir(), "keystone-texts-"));
      try {
        file = await decryptBackupFile(st.backupDir!, this.password, "HomeDomain", "Library/SMS/sms.db", tmp, this.keys);
      } catch (e) {
        rmSync(tmp, { recursive: true, force: true });
        throw (e as Error).message === "WRONG_KEY" ? new Error("Couldn't read the encrypted backup with that password.") : e;
      }
    }
    const db = new sqlite.DatabaseSync(file, { readOnly: true });
    try {
      const secs = since.getTime() / 1000 - APPLE_EPOCH;
      // Dates are nanoseconds since 2001 on current iPhones (too big for a plain number, so SQLite turns them into
      // seconds), seconds on very old ones.
      const rows = db
        .prepare(
          `SELECT m.ROWID AS id, m.text AS text, m.attributedBody AS body, m.is_from_me AS fromMe, h.id AS handle,
                  (CASE WHEN m.date > 100000000000 THEN m.date / 1000000000 ELSE m.date END) AS secs
           FROM message m JOIN handle h ON h.ROWID = m.handle_id
           WHERE (CASE WHEN m.date > 100000000000 THEN m.date / 1000000000 ELSE m.date END) >= ?
           ORDER BY m.date DESC LIMIT 20000`,
        )
        .all(Math.floor(secs)) as { id: number | bigint; text: string | null; body: Uint8Array | null; fromMe: number | bigint; secs: number | bigint; handle: string }[];
      return rows
        .map((r) => {
          const unix = Number(r.secs) + APPLE_EPOCH;
          return { id: String(r.id), handle: r.handle, fromMe: Number(r.fromMe) === 1, at: new Date(unix * 1000).toISOString(), text: (r.text ?? "").trim() || textFromAttributedBody(r.body) };
        })
        .filter((m) => m.handle);
    } finally {
      db.close();
      if (tmp) rmSync(tmp, { recursive: true, force: true });
    }
  }
}

/** For tests and mock mode: a fixed list. */
export class MockTexts implements TextsClient {
  readonly kind = "mock" as const;
  constructor(public list: TextMessage[] = [], private on = true) {}
  status(): TextsStatus {
    return this.on ? { connected: true, backupAt: new Date().toISOString() } : { connected: false, problem: "Texts aren't connected." };
  }
  async messages(since: Date) {
    return this.list.filter((m) => Date.parse(m.at) >= since.getTime()).sort((a, b) => b.at.localeCompare(a.at));
  }
}

export class NoTexts implements TextsClient {
  readonly kind = "off" as const;
  status(): TextsStatus {
    return { connected: false, problem: "iPhone texts aren't turned on. Double-click Connect iPhone texts." };
  }
  async messages(): Promise<TextMessage[]> {
    return [];
  }
}

export function makeTexts(cfg: Config): TextsClient {
  if (cfg.mode === "mock") return new MockTexts([], false);
  return cfg.texts.enabled ? new IphoneBackupTexts(cfg.texts.backupDir || undefined, cfg.texts.password) : new NoTexts();
}
