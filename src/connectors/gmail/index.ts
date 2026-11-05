import type { Config } from "../../core/config.js";
import { GoogleGmail } from "./google.js";
import { MockGmail } from "./mock.js";
import type { MailClient } from "./types.js";

export * from "./types.js";
export { GoogleGmail, MockGmail };

export function makeGmail(cfg: Config): MailClient {
  return cfg.gmail.driver === "google"
    ? new GoogleGmail({ clientId: cfg.gmail.clientId, clientSecret: cfg.gmail.clientSecret, tokenFile: cfg.gmail.tokenFile, address: cfg.gmail.address })
    : new MockGmail(cfg.stateDir);
}
