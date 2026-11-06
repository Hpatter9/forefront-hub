import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import http from "node:http";
import type { AddressInfo } from "node:net";
import path from "node:path";
import { google } from "googleapis";

/**
 * One Google sign-in for the hub: Gmail (read, label, send, drafts) and Google Calendar (read and write events).
 * The token lives in auth/google-token.json (never committed). Signing in again adds any scope the hub gained since.
 */
export const SCOPES = {
  gmailModify: "https://www.googleapis.com/auth/gmail.modify",
  gmailCompose: "https://www.googleapis.com/auth/gmail.compose",
  calendar: "https://www.googleapis.com/auth/calendar",
  tasks: "https://www.googleapis.com/auth/tasks",
};

export interface GoogleOpts {
  clientId: string;
  clientSecret: string;
  tokenFile: string;
  address: string;
}

type OAuth = InstanceType<typeof google.auth.OAuth2>;
const shared = new Map<string, OAuth>();

export class GoogleAuth {
  constructor(private opts: GoogleOpts) {}

  get address() {
    return this.opts.address;
  }

  hasScope(scope: string): boolean {
    if (!existsSync(this.opts.tokenFile)) return false;
    const s: string = JSON.parse(readFileSync(this.opts.tokenFile, "utf8")).scope ?? "";
    return s.split(/\s+/).includes(scope);
  }

  connected(): boolean {
    return existsSync(this.opts.tokenFile);
  }

  /** An authorised client (one per token file, so a refreshed token is shared by Gmail and Calendar). */
  client(): OAuth {
    const hit = shared.get(this.opts.tokenFile);
    if (hit) return hit;
    if (!existsSync(this.opts.tokenFile)) throw new Error("Google isn't connected yet. Double-click Connect Gmail in the hub folder.");
    const oauth = new google.auth.OAuth2(this.opts.clientId, this.opts.clientSecret);
    oauth.setCredentials(JSON.parse(readFileSync(this.opts.tokenFile, "utf8")));
    oauth.on("tokens", (t) => {
      const old = JSON.parse(readFileSync(this.opts.tokenFile, "utf8"));
      writeFileSync(this.opts.tokenFile, JSON.stringify({ ...old, ...t }, null, 2));
    });
    shared.set(this.opts.tokenFile, oauth);
    return oauth;
  }

  /** Opens Google's consent page in the browser, waits for the answer, saves the token. */
  async login(): Promise<void> {
    const server = http.createServer();
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    const redirect = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const oauth = new google.auth.OAuth2(this.opts.clientId, this.opts.clientSecret, redirect);
    const url = oauth.generateAuthUrl({ access_type: "offline", prompt: "consent", scope: Object.values(SCOPES), login_hint: this.opts.address });
    const code = await new Promise<string>((resolve, reject) => {
      server.on("request", (req, res) => {
        const u = new URL(req.url ?? "/", redirect);
        const c = u.searchParams.get("code");
        res.end(c ? "Gmail, Google Calendar and Google Tasks are connected to the Forefront hub. You can close this tab." : `Error: ${u.searchParams.get("error")}`);
        c ? resolve(c) : reject(new Error(u.searchParams.get("error") ?? "no code"));
      });
      console.log(`Opening Google sign-in. If it doesn't open, paste this into your browser:\n${url}\n`);
      openBrowser(url);
    });
    server.close();
    const { tokens } = await oauth.getToken(code);
    mkdirSync(path.dirname(this.opts.tokenFile), { recursive: true });
    writeFileSync(this.opts.tokenFile, JSON.stringify(tokens, null, 2));
    shared.delete(this.opts.tokenFile);
    console.log(`Saved the Google sign-in to ${this.opts.tokenFile}`);
  }
}

export function openBrowser(url: string) {
  const cmd = process.platform === "win32" ? ["cmd", ["/c", "start", '""', `"${url}"`]] : process.platform === "darwin" ? ["open", [url]] : ["xdg-open", [url]];
  try {
    spawn(cmd[0] as string, cmd[1] as string[], { stdio: "ignore", detached: true, shell: process.platform === "win32" }).unref();
  } catch {
    /* the URL is printed too */
  }
}
