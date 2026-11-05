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

export function htmlToText(html: string): string {
  return html
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(div|p|tr|li)>/gi, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function wrap76(b64: string): string {
  return b64.replace(/.{1,76}/g, "$&\r\n").trimEnd();
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
    d.inReplyTo ? `In-Reply-To: ${d.inReplyTo}\r\nReferences: ${d.inReplyTo}` : "",
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
