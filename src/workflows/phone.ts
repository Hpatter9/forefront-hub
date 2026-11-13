import { createCipheriv, pbkdf2Sync, randomBytes, randomInt } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import os from "node:os";
import path from "node:path";
import type { Hub } from "../hub.js";
import { allContacts } from "./contacts.js";
import { inventory } from "./inventory.js";

/**
 * Connecting the Keystone phone app (phone/). The phone works without the laptop: it talks to Homebase, Google and
 * Gemini itself. To do that it needs the same keys Keystone has, so once, on the same Wi-Fi, the laptop hands them
 * over: it shows an address and a 6-digit code, and serves the setup locked with that code (the code itself never
 * crosses the network; the phone unlocks the setup with what Hunter types). The same little page offers the app's
 * install file. It stays up for a few minutes and only while the Connect phone window is open.
 */
export const PAIR_ROUNDS = 600_000;

export interface PhoneSetup {
  homebase: { url: string; token: string };
  me: { name: string; email: string };
  google: { clientId: string; clientSecret: string; refreshToken: string } | null;
  gemini: { key: string; model: string; fallbacks: string[] } | null;
  contacts: { name: string; company?: string; title?: string; emails: string[]; phones: string[]; jobs: { jobNumber: number; name: string; role: string }[] }[];
  /** The shop's overstock, as of now (from the inventory sheet on the laptop). */
  stock: { type: string; product: string; color: string; amount: string; location: string; status: string; notes: string }[];
  madeAt: string;
}

/** What the phone needs: the keys, who Hunter is, and a copy of his Keystone contacts (people he named himself too). */
export function phoneSetup(hub: Hub): PhoneSetup {
  const c = hub.cfg;
  let refreshToken = "";
  try {
    if (existsSync(c.gmail.tokenFile)) refreshToken = JSON.parse(readFileSync(c.gmail.tokenFile, "utf8")).refresh_token ?? "";
  } catch {
    // no Google sign-in yet
  }
  return {
    homebase: { url: c.homebase.url, token: c.homebase.apiToken },
    me: { name: c.homebase.me, email: c.gmail.address },
    google: refreshToken && c.gmail.clientId ? { clientId: c.gmail.clientId, clientSecret: c.gmail.clientSecret, refreshToken } : null,
    gemini: c.ai.geminiKey ? { key: c.ai.geminiKey, model: c.ai.geminiModel, fallbacks: c.ai.geminiFallbacks ?? [] } : null,
    contacts: allContacts(hub)
      .filter((p) => p.name && (p.phones.length || p.emails.length))
      .slice(0, 1500)
      .map((p) => ({ name: p.name, company: p.company, title: p.title, emails: p.emails.slice(0, 3), phones: p.phones.map((x) => x.number), jobs: p.jobs.slice(0, 6) })),
    stock: inventory(hub).items.slice(0, 300).map((x) => ({ type: x.type, product: x.product, color: x.color, amount: x.amount || "not counted yet", location: x.location, status: x.status, notes: x.notes.slice(0, 300) })),
    madeAt: new Date().toISOString(),
  };
}

/** The setup locked with the code: AES-256-GCM under a key stretched from the code (the tag follows the data). */
export function lockSetup(setup: PhoneSetup, code: string) {
  const salt = randomBytes(16), iv = randomBytes(12);
  const key = pbkdf2Sync(code, salt, PAIR_ROUNDS, 32, "sha256");
  const aes = createCipheriv("aes-256-gcm", key, iv);
  const data = Buffer.concat([aes.update(JSON.stringify(setup), "utf8"), aes.final(), aes.getAuthTag()]);
  return { v: 1, rounds: PAIR_ROUNDS, salt: salt.toString("base64"), iv: iv.toString("base64"), data: data.toString("base64") };
}

/** This computer's address on the Wi-Fi (home networks first). */
export function lanAddress(): string {
  const all = Object.values(os.networkInterfaces()).flat().filter((a): a is os.NetworkInterfaceInfo => !!a && a.family === "IPv4" && !a.internal);
  return (all.find((a) => a.address.startsWith("192.168.")) ?? all.find((a) => a.address.startsWith("10.")) ?? all.find((a) => /^172\.(1[6-9]|2\d|3[01])\./.test(a.address)) ?? all[0])?.address ?? "";
}

const page = (apk: boolean) => `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Keystone for your phone</title>
<body style="margin:0;background:#0a1c36;color:#eaf3ff;font:18px/1.5 system-ui,sans-serif;padding:24px 20px">
<h1 style="margin:0 0 8px;font-size:26px">Keystone for your phone</h1>
${apk ? `<p style="color:#a9c3e6">1. Tap the button to download the app, then open the download and tap Install. If the phone asks, allow your browser to install apps.</p>
<p><a href="/keystone.apk" style="display:block;text-align:center;background:#7fd0ff;color:#06203c;font-weight:600;padding:16px;border-radius:10px;text-decoration:none">Download Keystone</a></p>
<p style="color:#a9c3e6">2. Open Keystone on the phone and type the address and 6-digit code shown on the laptop.</p>` : `<p style="color:#ffb38a">The app file isn't in the Keystone folder yet. Close and reopen Keystone on the laptop to update, then try again.</p>`}
</body>`;

/** Serves the install page, the app file and the locked setup on the local network until closed. */
export function servePairing(hub: Hub, opts: { port?: number; code?: string; apkFile?: string } = {}): Promise<{ server: Server; code: string; port: number }> {
  const code = opts.code ?? String(randomInt(0, 1_000_000)).padStart(6, "0");
  const box = JSON.stringify(lockSetup(phoneSetup(hub), code));
  const apk = opts.apkFile ?? path.join(hub.cfg.hubRoot, "phone", "keystone.apk");
  const server = createServer((req, res) => {
    const url = (req.url ?? "/").split("?")[0];
    if (req.method !== "GET") return void res.writeHead(405).end();
    if (url === "/pair") return void res.writeHead(200, { "Content-Type": "application/json", "Cache-Control": "no-store" }).end(box);
    if (url === "/keystone.apk" && existsSync(apk)) return void res.writeHead(200, { "Content-Type": "application/vnd.android.package-archive", "Content-Disposition": 'attachment; filename="keystone.apk"' }).end(readFileSync(apk));
    if (url === "/") return void res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" }).end(page(existsSync(apk)));
    res.writeHead(404).end();
  });
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(opts.port ?? 4320, "0.0.0.0", () => resolve({ server, code, port: (server.address() as { port: number }).port }));
  });
}
