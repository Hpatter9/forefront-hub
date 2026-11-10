import { createDecipheriv, pbkdf2Sync } from "node:crypto";
import { closeSync, createReadStream, createWriteStream, ftruncateSync, openSync, readFileSync, readSync, statSync } from "node:fs";
import path from "node:path";
import { pipeline } from "node:stream/promises";

/**
 * Reading an ENCRYPTED iPhone backup with its backup password (the one typed into Apple Devices / iTunes when
 * encryption was turned on). Apple's format: Manifest.plist holds a keybag of class keys wrapped with a key derived
 * from the password; Manifest.db is encrypted with a key wrapped by one of those class keys; each file has its own
 * key (in Manifest.db), wrapped by its protection class's key. Everything here only reads.
 */

// ---- binary property lists (Manifest.plist and the per-file records in Manifest.db)
export interface Uid {
  UID: number;
}
export function parseBplist(buf: Buffer): any {
  if (buf.subarray(0, 6).toString("latin1") !== "bplist") throw new Error("Not a binary property list.");
  const t = buf.subarray(buf.length - 32);
  const offSize = t[6], refSize = t[7];
  const num = Number(t.readBigUInt64BE(8)), top = Number(t.readBigUInt64BE(16)), table = Number(t.readBigUInt64BE(24));
  const uint = (pos: number, size: number) => {
    let n = 0;
    for (let i = 0; i < size; i++) n = n * 256 + buf[pos + i];
    return n;
  };
  const offsets = Array.from({ length: num }, (_, i) => uint(table + i * offSize, offSize));
  const memo = new Map<number, any>();
  const read = (idx: number): any => {
    if (memo.has(idx)) return memo.get(idx);
    let p = offsets[idx];
    const marker = buf[p++];
    const type = marker >> 4;
    let info = marker & 0x0f;
    const count = () => {
      if (info !== 0x0f) return info;
      const m = buf[p++];
      const size = 1 << (m & 0x0f);
      const n = uint(p, size);
      p += size;
      return n;
    };
    let v: any;
    switch (type) {
      case 0x0: v = info === 0x08 ? false : info === 0x09 ? true : null; break;
      case 0x1: { const size = 1 << info; v = size === 8 ? Number(buf.readBigInt64BE(p)) : uint(p + Math.max(0, size - 8), Math.min(size, 8)); break; }
      case 0x2: v = info === 2 ? buf.readFloatBE(p) : buf.readDoubleBE(p); break;
      case 0x3: v = new Date((buf.readDoubleBE(p) + 978307200) * 1000); break;
      case 0x4: { const n = count(); v = Buffer.from(buf.subarray(p, p + n)); break; }
      case 0x5: { const n = count(); v = buf.subarray(p, p + n).toString("latin1"); break; }
      case 0x6: { const n = count(); v = Buffer.from(buf.subarray(p, p + n * 2)).swap16().toString("utf16le"); break; }
      case 0x8: v = { UID: uint(p, info + 1) } satisfies Uid; break;
      case 0xa:
      case 0xc: { const n = count(); v = []; memo.set(idx, v); for (let i = 0; i < n; i++) v.push(read(uint(p + i * refSize, refSize))); return v; }
      case 0xd: { const n = count(); v = {}; memo.set(idx, v); for (let i = 0; i < n; i++) v[String(read(uint(p + i * refSize, refSize)))] = read(uint(p + (n + i) * refSize, refSize)); return v; }
      default: throw new Error(`Property list type ${type} isn't supported.`);
    }
    memo.set(idx, v);
    return v;
  };
  return read(top);
}

// ---- AES key unwrap (RFC 3394)
export function aesUnwrap(kek: Buffer, wrapped: Buffer): Buffer | null {
  const n = wrapped.length / 8 - 1;
  if (n < 1 || wrapped.length % 8) return null;
  let a = Buffer.from(wrapped.subarray(0, 8));
  const r = Array.from({ length: n }, (_, i) => Buffer.from(wrapped.subarray(8 + i * 8, 16 + i * 8)));
  for (let j = 5; j >= 0; j--) {
    for (let i = n; i >= 1; i--) {
      const t = Buffer.alloc(8);
      t.writeBigUInt64BE(BigInt(n * j + i));
      const d = createDecipheriv("aes-256-ecb", kek, null).setAutoPadding(false);
      const b = Buffer.concat([d.update(Buffer.concat([Buffer.from(a.map((x, k) => x ^ t[k])), r[i - 1]])), d.final()]);
      a = Buffer.from(b.subarray(0, 8));
      r[i - 1] = Buffer.from(b.subarray(8));
    }
  }
  return a.equals(Buffer.from("a6a6a6a6a6a6a6a6", "hex")) ? Buffer.concat(r) : null;
}

// ---- the keybag
export interface Keybag {
  attrs: Record<string, Buffer | number>;
  classKeys: Map<number, { wrap: number; wpky?: Buffer; key?: Buffer }>;
}
export function parseKeybag(blob: Buffer): Keybag {
  const kb: Keybag = { attrs: {}, classKeys: new Map() };
  let cur: { clas?: number; wrap: number; wpky?: Buffer } | null = null;
  let seenUuid = false, seenWrap = false;
  const flush = () => { if (cur?.clas !== undefined) kb.classKeys.set(cur.clas, { wrap: cur.wrap, wpky: cur.wpky }); };
  for (let p = 0; p + 8 <= blob.length; ) {
    const tag = blob.subarray(p, p + 4).toString("latin1");
    const len = blob.readUInt32BE(p + 4);
    const data = blob.subarray(p + 8, p + 8 + len);
    p += 8 + len;
    const val: Buffer | number = len === 4 ? data.readUInt32BE(0) : Buffer.from(data);
    if (tag === "UUID" && !seenUuid) { seenUuid = true; kb.attrs.UUID = val; }
    else if (tag === "WRAP" && !seenWrap) { seenWrap = true; kb.attrs.WRAP = val; }
    else if (tag === "UUID") { flush(); cur = { wrap: 0 }; }
    else if (cur && tag === "CLAS") cur.clas = val as number;
    else if (cur && tag === "WRAP") cur.wrap = val as number;
    else if (cur && tag === "WPKY") cur.wpky = val as Buffer;
    else if (cur && (tag === "KTYP" || tag === "PBKY")) { /* not needed */ }
    else kb.attrs[tag] = val;
  }
  flush();
  return kb;
}

/** Unlocks the class keys with the backup password. False when the password is wrong. */
export function unlockKeybag(kb: Keybag, password: string): boolean {
  const { DPSL, DPIC, SALT, ITER } = kb.attrs as Record<string, any>;
  if (!SALT || !ITER) throw new Error("This backup's keybag is in a format Keystone doesn't know.");
  // Newer iPhones (iOS 10.2+) add a first, slow round (about 10 million steps): this takes several seconds.
  const first = DPSL && DPIC ? pbkdf2Sync(Buffer.from(password, "utf8"), DPSL, DPIC, 32, "sha256") : Buffer.from(password, "utf8");
  const key = pbkdf2Sync(first, SALT, ITER, 32, "sha1");
  let any = false;
  for (const ck of kb.classKeys.values()) {
    if (!ck.wpky || !(ck.wrap & 2)) continue;
    const k = aesUnwrap(key, ck.wpky);
    if (!k) return false;
    ck.key = k;
    any = true;
  }
  return any;
}

function classKey(kb: Keybag, cls: number): Buffer {
  const k = kb.classKeys.get(cls)?.key;
  if (!k) throw new Error(`The backup has no key for protection class ${cls}.`);
  return k;
}

async function decryptTo(src: string, dest: string, key: Buffer) {
  await pipeline(createReadStream(src), createDecipheriv("aes-256-cbc", key, Buffer.alloc(16)).setAutoPadding(false), createWriteStream(dest));
  // Drop the encryption padding: a SQLite file says how long it really is in its header.
  const fd = openSync(dest, "r+");
  try {
    const h = Buffer.alloc(32);
    readSync(fd, h, 0, 32, 0);
    if (h.subarray(0, 15).toString("latin1") !== "SQLite format 3") throw new Error("WRONG_KEY");
    const page = h.readUInt16BE(16) === 1 ? 65536 : h.readUInt16BE(16);
    const size = page * h.readUInt32BE(28);
    if (size > 0 && size <= statSync(dest).size) ftruncateSync(fd, size);
  } finally {
    closeSync(fd);
  }
}

/**
 * Decrypts one file of an encrypted backup (by its domain and path) into `outDir` and returns where it is.
 * `keys` caches the unlocked keybag between calls, since unlocking takes several seconds.
 */
export async function decryptBackupFile(backupDir: string, password: string, domain: string, relativePath: string, outDir: string, keys?: { kb?: Keybag; stamp?: string }): Promise<string> {
  const plistFile = path.join(backupDir, "Manifest.plist");
  const manifest = parseBplist(readFileSync(plistFile));
  if (!manifest.BackupKeyBag || !manifest.ManifestKey) throw new Error("This backup doesn't look encrypted the usual way (no keybag in Manifest.plist).");
  const stamp = `${backupDir}:${statSync(plistFile).mtimeMs}`;
  let kb = keys?.stamp === stamp ? keys.kb : undefined;
  if (!kb) {
    kb = parseKeybag(manifest.BackupKeyBag);
    if (!unlockKeybag(kb, password)) throw new Error("That isn't the backup password for this iPhone backup. Double-click Connect iPhone texts and type it again.");
    if (keys) { keys.kb = kb; keys.stamp = stamp; }
  }
  const mk: Buffer = manifest.ManifestKey;
  const manifestKey = aesUnwrap(classKey(kb, mk.readUInt32LE(0)), mk.subarray(4));
  if (!manifestKey) throw new Error("Couldn't open the backup's index with that password.");
  const manifestDb = path.join(outDir, "Manifest.db");
  await decryptTo(path.join(backupDir, "Manifest.db"), manifestDb, manifestKey);
  const sqlite = await import("node:sqlite");
  const db = new sqlite.DatabaseSync(manifestDb, { readOnly: true });
  let row: { fileID: string; file: Uint8Array } | undefined;
  try {
    row = db.prepare("SELECT fileID, file FROM Files WHERE domain = ? AND relativePath = ?").get(domain, relativePath) as any;
  } finally {
    db.close();
  }
  if (!row) throw new Error(`The backup doesn't contain ${relativePath}. Click Back Up Now in Apple Devices and let it finish.`);
  const rec = parseBplist(Buffer.from(row.file));
  const root = rec.$objects[rec.$top.root.UID];
  const wrapped: Buffer = rec.$objects[root.EncryptionKey.UID]["NS.data"];
  const fileKey = aesUnwrap(classKey(kb, root.ProtectionClass), wrapped.subarray(4));
  if (!fileKey) throw new Error("Couldn't unlock the Messages file in the backup.");
  const out = path.join(outDir, path.basename(relativePath));
  await decryptTo(path.join(backupDir, row.fileID.slice(0, 2), row.fileID), out, fileKey);
  return out;
}
