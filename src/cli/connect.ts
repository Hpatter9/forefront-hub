import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { createInterface } from "node:readline/promises";
import { loadConfig } from "../core/config.js";
import { GoogleGmail, openBrowser } from "../connectors/gmail/google.js";

/** Guided set-up for Gmail and CompanyCam: opens the right pages, takes the values, saves them to .env, tests them. */

function envPath() {
  return path.join(loadConfig().hubRoot, ".env");
}

export function setEnv(values: Record<string, string>, file = envPath()) {
  const lines = existsSync(file) ? readFileSync(file, "utf8").split(/\r?\n/) : [];
  for (const [k, v] of Object.entries(values)) {
    const i = lines.findIndex((l) => l.startsWith(`${k}=`));
    if (i >= 0) lines[i] = `${k}=${v}`;
    else lines.push(`${k}=${v}`);
  }
  writeFileSync(file, lines.join("\n").replace(/\n*$/, "\n"));
  for (const [k, v] of Object.entries(values)) process.env[k] = v;
}

async function ask(q: string): Promise<string> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    return (await rl.question(q)).trim();
  } finally {
    rl.close();
  }
}

function step(n: number, text: string) {
  console.log(`\n${n}. ${text}`);
}

/** Google's "Download JSON" for a Desktop client lands in Downloads as client_secret_<id>.json. */
function findClientJson(): { id: string; secret: string; file: string } | null {
  const dl = loadConfig().docusketch.downloadsDir;
  if (!existsSync(dl)) return null;
  const files = readdirSync(dl)
    .filter((f) => /^client_secret_.*\.json$/i.test(f))
    .map((f) => path.join(dl, f))
    .sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs);
  for (const file of files) {
    try {
      const j = JSON.parse(readFileSync(file, "utf8"));
      const c = j.installed ?? j.web;
      if (c?.client_id && c?.client_secret) return { id: c.client_id, secret: c.client_secret, file };
    } catch {
      /* not one of Google's files */
    }
  }
  return null;
}

export async function connectGmail() {
  const cfg = loadConfig();
  console.log("Connecting Gmail (hunter@forefrontteam.com) for the hub's Mail tab: reading, drafts, archive/labels, and sending when you press Send.");
  if (!cfg.gmail.clientId) {
    console.log("Google needs a one-time 'app' entry for the hub. Each page opens in your browser; sign in as hunter@forefrontteam.com.");
    step(1, "Create a project named Forefront Hub (Create).");
    openBrowser("https://console.cloud.google.com/projectcreate");
    await ask("   Press Enter when it's created... ");
    step(2, "Make sure Forefront Hub is the selected project at the top, then click Enable on the Gmail API.");
    openBrowser("https://console.cloud.google.com/apis/library/gmail.googleapis.com");
    await ask("   Press Enter when it says API enabled... ");
    step(3, "Click Get started: app name Forefront Hub, your email, Audience = Internal, your email again, agree, Create.");
    console.log("   (If Internal is greyed out, pick External and add hunter@forefrontteam.com as a test user.)");
    openBrowser("https://console.cloud.google.com/auth/overview");
    await ask("   Press Enter when it's done... ");
    step(4, "Create client: Application type = Desktop app, name Forefront Hub, Create. Then click Download JSON.");
    openBrowser("https://console.cloud.google.com/auth/clients/create");
    await ask("   Press Enter once the JSON file is downloaded (or if you'd rather paste the ID and secret)... ");

    let creds = findClientJson();
    if (creds) console.log(`   Found ${path.basename(creds.file)} in Downloads.`);
    else {
      const id = await ask("   Paste the Client ID: ");
      const secret = await ask("   Paste the Client secret: ");
      if (!id || !secret) throw new Error("No client ID / secret; run Connect Gmail again when you have them.");
      creds = { id, secret, file: "" };
    }
    setEnv({ GOOGLE_CLIENT_ID: creds.id, GOOGLE_CLIENT_SECRET: creds.secret });
  }

  step(5, "Sign in to Google in the browser window that opens and click Allow.");
  const c = loadConfig();
  const gmail = new GoogleGmail({ clientId: c.gmail.clientId, clientSecret: c.gmail.clientSecret, tokenFile: c.gmail.tokenFile, address: c.gmail.address });
  await gmail.login();
  const sent = await gmail.search("in:sent", 1);
  console.log(`\nGmail is connected. Latest sent email: "${sent[0]?.subject ?? "(none)"}".`);
  console.log("Restart the hub (close its window, open the desktop icon) to use it.");
}

export async function connectCompanyCam() {
  console.log("Connecting CompanyCam.");
  step(1, "In CompanyCam (signed in as an admin) open the menu > Company Settings > Integrations (or Access Tokens / API).");
  console.log("   Create a new access token named Forefront Hub and copy it.");
  console.log("   If there's no such page on your plan, ask CompanyCam support for 'a v2 API access token'.");
  openBrowser("https://app.companycam.com/");
  const token = await ask("\n2. Paste the token here and press Enter: ");
  if (!token) throw new Error("No token; run Connect CompanyCam again when you have one.");
  const res = await fetch("https://api.companycam.com/v2/users/current", { headers: { Authorization: `Bearer ${token}`, Accept: "application/json" } });
  if (!res.ok) throw new Error(`CompanyCam didn't accept that token (${res.status}). Check you copied all of it and try again.`);
  const me: any = await res.json();
  setEnv({ COMPANYCAM_TOKEN: token });
  console.log(`\nCompanyCam is connected as ${[me.first_name, me.last_name].filter(Boolean).join(" ") || me.email_address || "you"}.`);
  console.log("Restart the hub (close its window, open the desktop icon) to use it.");
}
