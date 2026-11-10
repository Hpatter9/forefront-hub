import { execFileSync } from "node:child_process";
import { createCipheriv, pbkdf2Sync, randomBytes } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import { aesUnwrap, parseBplist } from "../src/connectors/texts/backupCrypto.js";
import { IphoneBackupTexts } from "../src/connectors/texts/index.js";
import { PYTHON } from "./helpers.js";

const SMS = "3d0d7e5fb2ce288813306e4d4636395e047a3d28";

/** RFC 3394 key wrap (the test's own, so the reader's unwrap is checked against an independent wrap). */
function aesWrap(kek: Buffer, key: Buffer): Buffer {
  const n = key.length / 8;
  let a = Buffer.from("a6a6a6a6a6a6a6a6", "hex");
  const r = Array.from({ length: n }, (_, i) => Buffer.from(key.subarray(i * 8, i * 8 + 8)));
  for (let j = 0; j < 6; j++) for (let i = 1; i <= n; i++) {
    const c = createCipheriv("aes-256-ecb", kek, null).setAutoPadding(false);
    const b = Buffer.concat([c.update(Buffer.concat([a, r[i - 1]])), c.final()]);
    const t = Buffer.alloc(8); t.writeBigUInt64BE(BigInt(n * j + i));
    a = Buffer.from(b.subarray(0, 8).map((x, k) => x ^ t[k]));
    r[i - 1] = Buffer.from(b.subarray(8));
  }
  return Buffer.concat([a, ...r]);
}
const cbc = (key: Buffer, data: Buffer) => { const c = createCipheriv("aes-256-cbc", key, Buffer.alloc(16)); return Buffer.concat([c.update(data), c.final()]); };
const tlv = (tag: string, data: Buffer | number) => { const d = typeof data === "number" ? (() => { const b = Buffer.alloc(4); b.writeUInt32BE(data); return b; })() : data; const l = Buffer.alloc(4); l.writeUInt32BE(d.length); return Buffer.concat([Buffer.from(tag, "latin1"), l, d]); };
const plist = (obj: unknown) => execFileSync(PYTHON, ["-c", `
import sys, json, plistlib
def conv(x):
    if isinstance(x, dict):
        if set(x) == {"$hex"}: return bytes.fromhex(x["$hex"])
        if set(x) == {"$uid"}: return plistlib.UID(x["$uid"])
        return {k: conv(v) for k, v in x.items()}
    if isinstance(x, list): return [conv(v) for v in x]
    return x
sys.stdout.buffer.write(plistlib.dumps(conv(json.load(sys.stdin)), fmt=plistlib.FMT_BINARY))`], { input: JSON.stringify(obj) });
const hex = (b: Buffer) => ({ $hex: b.toString("hex") });

/** A made-up ENCRYPTED iPhone backup, laid out the way Apple does it (small iteration counts to keep it quick). */
function fakeEncryptedBackup(password: string) {
  const dir = path.join(mkdtempSync(path.join(os.tmpdir(), "encbackup-")), "00008030-FAKE");
  mkdirSync(path.join(dir, SMS.slice(0, 2)), { recursive: true });
  const tmp = mkdtempSync(path.join(os.tmpdir(), "encsrc-"));
  // the Messages database
  const smsPath = path.join(tmp, "sms.db");
  const sms = new DatabaseSync(smsPath);
  sms.exec("CREATE TABLE handle (ROWID INTEGER PRIMARY KEY, id TEXT); CREATE TABLE message (ROWID INTEGER PRIMARY KEY, text TEXT, attributedBody BLOB, is_from_me INTEGER, date INTEGER, handle_id INTEGER)");
  sms.prepare("INSERT INTO handle VALUES (1, ?)").run("+13035550100");
  sms.prepare("INSERT INTO message (text, is_from_me, date, handle_id) VALUES (?, 1, ?, 1)").run("On my way to the walk", BigInt(Math.round(Date.now() / 1000 - 3600 - 978307200)) * 1000000000n);
  sms.close();
  // keys: password -> passcode key -> class keys -> manifest key and the file's key
  const dpsl = randomBytes(20), salt = randomBytes(20), DPIC = 1000, ITER = 100;
  const passKey = pbkdf2Sync(pbkdf2Sync(Buffer.from(password), dpsl, DPIC, 32, "sha256"), salt, ITER, 32, "sha1");
  const class3 = randomBytes(32), class4 = randomBytes(32), manifestKey = randomBytes(32), fileKey = randomBytes(32);
  const keybag = Buffer.concat([
    tlv("VERS", 5), tlv("TYPE", 1), tlv("UUID", randomBytes(16)), tlv("HMCK", randomBytes(40)), tlv("WRAP", 0), tlv("SALT", salt), tlv("ITER", ITER), tlv("DPWT", 0), tlv("DPIC", DPIC), tlv("DPSL", dpsl),
    tlv("UUID", randomBytes(16)), tlv("CLAS", 3), tlv("WRAP", 2), tlv("KTYP", 0), tlv("WPKY", aesWrap(passKey, class3)),
    tlv("UUID", randomBytes(16)), tlv("CLAS", 4), tlv("WRAP", 2), tlv("KTYP", 0), tlv("WPKY", aesWrap(passKey, class4)),
  ]);
  const le = (n: number) => { const b = Buffer.alloc(4); b.writeUInt32LE(n); return b; };
  writeFileSync(path.join(dir, "Manifest.plist"), plist({ IsEncrypted: true, BackupKeyBag: hex(keybag), ManifestKey: hex(Buffer.concat([le(4), aesWrap(class4, manifestKey)])) }));
  // the index, with the Messages file's own wrapped key
  const record = plist({ $version: 100000, $archiver: "NSKeyedArchiver", $top: { root: { $uid: 1 } }, $objects: ["$null", { EncryptionKey: { $uid: 2 }, ProtectionClass: 3, Size: 4096 }, { "NS.data": hex(Buffer.concat([le(3), aesWrap(class3, fileKey)])) }] });
  const manPath = path.join(tmp, "Manifest.db");
  const man = new DatabaseSync(manPath);
  man.exec("CREATE TABLE Files (fileID TEXT PRIMARY KEY, domain TEXT, relativePath TEXT, flags INTEGER, file BLOB)");
  man.prepare("INSERT INTO Files VALUES (?, 'HomeDomain', 'Library/SMS/sms.db', 1, ?)").run(SMS, record);
  man.close();
  writeFileSync(path.join(dir, "Manifest.db"), cbc(manifestKey, readFileSync(manPath)));
  writeFileSync(path.join(dir, SMS.slice(0, 2), SMS), cbc(fileKey, readFileSync(smsPath)));
  return dir;
}

describe("encrypted iPhone backups", () => {
  it("unwraps keys and reads binary property lists", () => {
    const kek = randomBytes(32), key = randomBytes(32);
    expect(aesUnwrap(kek, aesWrap(kek, key))?.equals(key)).toBe(true);
    expect(aesUnwrap(randomBytes(32), aesWrap(kek, key))).toBeNull();
    const p = parseBplist(plist({ a: 5, big: 70000, s: "hi", u: "héllo", list: [true, false, { $uid: 3 }], d: hex(Buffer.from("xyz")) }));
    expect(p).toMatchObject({ a: 5, big: 70000, s: "hi", u: "héllo", list: [true, false, { UID: 3 }] });
    expect(p.d.toString()).toBe("xyz");
  });

  it("reads the texts with the backup password", async () => {
    const dir = fakeEncryptedBackup("correct horse");
    const c = new IphoneBackupTexts(dir, "correct horse");
    expect(c.status()).toMatchObject({ connected: true, encrypted: true });
    const list = await c.messages(new Date(Date.now() - 864e5));
    expect(list.map((m) => [m.handle, m.fromMe, m.text])).toEqual([["+13035550100", true, "On my way to the walk"]]);
    expect(await c.messages(new Date(Date.now() - 864e5))).toHaveLength(1); // again, with the keys already unlocked
  });

  it("asks for the password when there's none, and says so when it's wrong", async () => {
    const dir = fakeEncryptedBackup("correct horse");
    expect(new IphoneBackupTexts(dir).status()).toMatchObject({ connected: false, encrypted: true, problem: expect.stringMatching(/backup password/) });
    await expect(new IphoneBackupTexts(dir, "wrong").messages(new Date(0))).rejects.toThrow(/isn't the backup password/);
  });
});
