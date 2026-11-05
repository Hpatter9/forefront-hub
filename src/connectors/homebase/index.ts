import path from "node:path";
import type { Config } from "../../core/config.js";
import { ApiHomebase } from "./api.js";
import { BrowserHomebase } from "./browser.js";
import { MockHomebase } from "./mock.js";
import type { HomebaseClient } from "./types.js";

export * from "./types.js";
export { BrowserHomebase, MockHomebase, ApiHomebase };

export function makeHomebase(cfg: Config): HomebaseClient {
  switch (cfg.homebase.driver) {
    case "api":
      return new ApiHomebase({ url: cfg.homebase.url, token: cfg.homebase.apiToken });
    case "browser":
      return new BrowserHomebase({
        url: cfg.homebase.url,
        authFile: cfg.homebase.authFile,
        snapshotDir: path.join(cfg.hubRoot, "snapshots"),
      });
    default:
      return new MockHomebase(cfg.stateDir);
  }
}
