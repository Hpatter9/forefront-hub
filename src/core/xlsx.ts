import { readFileSync } from "node:fs";
import { inflateRawSync } from "node:zlib";

/**
 * Reads the cell values of an Excel workbook (.xlsx) with nothing but Node: an .xlsx is a zip of XML files.
 * Values only (text and numbers as shown; formulas give their last saved result); no styles, dates stay numbers.
 */
export type Sheet = { name: string; rows: (string | number | null)[][] };

function unzip(buf: Buffer): Map<string, Buffer> {
  const out = new Map<string, Buffer>();
  // The central directory lists every file; its end record is at the tail.
  let end = buf.length - 22;
  while (end >= 0 && buf.readUInt32LE(end) !== 0x06054b50) end--;
  if (end < 0) throw new Error("That isn't an Excel (.xlsx) file.");
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

const unesc = (s: string) => s.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n))).replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCodePoint(parseInt(n, 16))).replace(/&amp;/g, "&");
const texts = (xml: string) => [...xml.matchAll(/<t(?:\s[^>]*)?>([\s\S]*?)<\/t>/g)].map((m) => unesc(m[1])).join("");
const col = (ref: string) => [...ref.replace(/\d+/g, "")].reduce((n, ch) => n * 26 + ch.charCodeAt(0) - 64, 0) - 1;

export function readXlsx(file: string | Buffer): Sheet[] {
  const zip = unzip(typeof file === "string" ? readFileSync(file) : file);
  const xml = (name: string) => zip.get(name)?.toString("utf8") ?? "";
  const shared = [...xml("xl/sharedStrings.xml").matchAll(/<si>([\s\S]*?)<\/si>/g)].map((m) => texts(m[1].replace(/<rPh[\s\S]*?<\/rPh>/g, "")));
  const rels = new Map([...xml("xl/_rels/workbook.xml.rels").matchAll(/<Relationship\s[^>]*>/g)].map((m) => [m[0].match(/Id="([^"]+)"/)?.[1] ?? "", m[0].match(/Target="([^"]+)"/)?.[1] ?? ""]));
  const sheets: Sheet[] = [];
  for (const m of xml("xl/workbook.xml").matchAll(/<sheet\s[^>]*>/g)) {
    const name = unesc(m[0].match(/name="([^"]*)"/)?.[1] ?? "");
    const target = rels.get(m[0].match(/r:id="([^"]+)"/)?.[1] ?? "") ?? "";
    const body = xml(target.startsWith("/") ? target.slice(1) : `xl/${target}`);
    const rows: Sheet["rows"] = [];
    for (const r of body.matchAll(/<row\s[^>]*>([\s\S]*?)<\/row>/g)) {
      const row: Sheet["rows"][number] = [];
      for (const c of r[1].matchAll(/<c\s([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g)) {
        const ref = c[1].match(/r="([A-Z]+)\d+"/)?.[1];
        const type = c[1].match(/t="([^"]+)"/)?.[1];
        const v = c[2]?.match(/<v>([\s\S]*?)<\/v>/)?.[1];
        const value = type === "s" ? shared[Number(v)] ?? "" : type === "inlineStr" ? texts(c[2] ?? "") : type === "str" || type === "e" ? unesc(v ?? "") : v === undefined || v === "" ? null : Number.isNaN(Number(v)) ? unesc(v) : Number(v);
        const i = ref ? col(ref) : row.length;
        while (row.length < i) row.push(null);
        row[i] = value === "" ? null : value;
      }
      if (row.some((x) => x !== null)) rows.push(row);
    }
    sheets.push({ name, rows });
  }
  return sheets;
}
