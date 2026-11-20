import { readFileSync } from "node:fs";
import path from "node:path";
import type { DraftInput } from "./types.js";

const MIME_TYPES: Record<string, string> = {
  ".pdf": "application/pdf",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".png": "image/png",
  ".esx": "application/octet-stream",
  ".zip": "application/zip",
  ".xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
};

export function encodeHeader(s: string): string {
  return /^[\x20-\x7e]*$/.test(s) ? s : `=?UTF-8?B?${Buffer.from(s, "utf8").toString("base64")}?=`;
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

/** Plain paragraphs -> the same simple HTML Gmail writes, so the draft looks hand-typed. */
export function bodyHtml(body: string, signatureHtml = ""): string {
  const paras = body.trim().split(/\n\s*\n/).map((p) => `<div>${escapeHtml(p.trim()).replace(/\n/g, "<br>")}</div>`);
  const sig = signatureHtml ? `<br><div>-- </div><div class="gmail_signature">${signatureHtml}</div>` : "";
  return `<div dir="ltr">${paras.join("<div><br></div>")}${sig}</div>`;
}

const NAMED: Record<string, string> = { nbsp: " ", amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", rsquo: "\u2019", lsquo: "\u2018", rdquo: "\u201d", ldquo: "\u201c", ndash: "\u2013", mdash: "\u2014", hellip: "\u2026", bull: "\u2022", middot: "\u00b7", copy: "\u00a9", reg: "\u00ae", trade: "\u2122", deg: "\u00b0", frac12: "\u00bd", frac14: "\u00bc", frac34: "\u00be", times: "\u00d7" };
/** Turns HTML character codes back into the characters ("don&#39;t" -> "don't", "&amp;" -> "&"). */
export function decodeEntities(s: string): string {
  return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z][a-z0-9]+);/gi, (all, code: string) => {
    if (code[0] === "#") {
      const n = /^#x/i.test(code) ? parseInt(code.slice(2), 16) : parseInt(code.slice(1), 10);
      return Number.isFinite(n) && n > 0 && n <= 0x10ffff ? String.fromCodePoint(n) : all;
    }
    return NAMED[code.toLowerCase()] ?? all;
  });
}

export function htmlToText(html: string): string {
  return decodeEntities(html
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(div|p|tr|li)>/gi, "\n")
    .replace(/<[^>]+>/g, ""))
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function wrap76(b64: string): string {
  return b64.replace(/.{1,76}/g, "$&\r\n").trimEnd();
}

/** References for a reply: the earlier chain, ending with the message being answered (each id once). */
export function replyRefs(references: string | undefined, inReplyTo: string): string {
  const ids = `${references ?? ""} ${inReplyTo}`.match(/<[^<>\s]+>/g) ?? [inReplyTo];
  return [...new Set(ids)].slice(-20).join(" ");
}

/** A complete RFC 822 message (multipart/mixed: text + HTML alternative, then attachments). */
export function buildMime(d: DraftInput & { from: string; messageId: string; signatureHtml?: string }): string {
  const boundary = `mixed_${Math.random().toString(36).slice(2)}`;
  const alt = `alt_${Math.random().toString(36).slice(2)}`;
  const text = d.body.trim() + (d.signatureHtml ? `\n\n-- \n${htmlToText(d.signatureHtml)}` : "");
  const headers = [
    `From: ${d.from}`,
    `To: ${d.to.join(", ")}`,
    d.cc?.length ? `Cc: ${d.cc.join(", ")}` : "",
    d.bcc.length ? `Bcc: ${d.bcc.join(", ")}` : "",
    `Subject: ${encodeHeader(d.subject)}`,
    `Message-ID: ${d.messageId}`,
    d.inReplyTo ? `In-Reply-To: ${d.inReplyTo}\r\nReferences: ${replyRefs(d.references, d.inReplyTo)}` : "",
    "MIME-Version: 1.0",
    `Content-Type: multipart/mixed; boundary="${boundary}"`,
  ].filter(Boolean);

  const parts = [
    `--${boundary}`,
    `Content-Type: multipart/alternative; boundary="${alt}"`,
    "",
    `--${alt}`,
    "Content-Type: text/plain; charset=UTF-8",
    "Content-Transfer-Encoding: base64",
    "",
    wrap76(Buffer.from(text, "utf8").toString("base64")),
    `--${alt}`,
    "Content-Type: text/html; charset=UTF-8",
    "Content-Transfer-Encoding: base64",
    "",
    wrap76(Buffer.from(bodyHtml(d.body, d.signatureHtml), "utf8").toString("base64")),
    `--${alt}--`,
  ];
  for (const file of d.attachments) {
    const name = path.basename(file);
    const type = MIME_TYPES[path.extname(file).toLowerCase()] ?? "application/octet-stream";
    parts.push(
      `--${boundary}`,
      `Content-Type: ${type}; name="${encodeHeader(name)}"`,
      `Content-Disposition: attachment; filename="${encodeHeader(name)}"`,
      "Content-Transfer-Encoding: base64",
      "",
      wrap76(readFileSync(file).toString("base64")),
    );
  }
  parts.push(`--${boundary}--`, "");
  return [...headers, "", ...parts].join("\r\n");
}

export function newMessageId(domain = "forefrontteam.com"): string {
  return `<hub-${crypto.randomUUID()}@${domain}>`;
}
