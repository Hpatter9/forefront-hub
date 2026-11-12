import { inflateRawSync } from "node:zlib";

/** The files inside a zip (name -> bytes), with nothing but Node. Enough for .xlsx files and zips of photos. */
export function unzip(buf: Buffer): Map<string, Buffer> {
  const out = new Map<string, Buffer>();
  // The central directory lists every file; its end record is at the tail.
  let end = buf.length - 22;
  while (end >= 0 && buf.readUInt32LE(end) !== 0x06054b50) end--;
  if (end < 0) throw new Error("That isn't a zip file (or it's damaged).");
  let at = buf.readUInt32LE(end + 16);
  for (let i = buf.readUInt16LE(end + 10); i > 0 && buf.readUInt32LE(at) === 0x02014b50; i--) {
    const method = buf.readUInt16LE(at + 10), size = buf.readUInt32LE(at + 20), nameLen = buf.readUInt16LE(at + 28), extraLen = buf.readUInt16LE(at + 30), commentLen = buf.readUInt16LE(at + 32), local = buf.readUInt32LE(at + 42);
    const name = buf.toString("utf8", at + 46, at + 46 + nameLen);
    const start = local + 30 + buf.readUInt16LE(local + 26) + buf.readUInt16LE(local + 28);
    const data = buf.subarray(start, start + size);
    if (!name.endsWith("/")) out.set(name, method === 0 ? data : inflateRawSync(data));
    at += 46 + nameLen + extraLen + commentLen;
  }
  return out;
}

