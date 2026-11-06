#!/usr/bin/env node
import { Command } from "commander";
import { FixedApprover } from "../core/approval.js";
import { loadConfig } from "../core/config.js";
import { BrowserHomebase } from "../connectors/homebase/browser.js";
import { GoogleGmail } from "../connectors/gmail/google.js";
import { MockGmail } from "../connectors/gmail/mock.js";
import { describe, makeHub, type Hub } from "../hub.js";
import { downloadPhotos, pullJob } from "../workflows/pull.js";
import { sendoff } from "../workflows/sendoff.js";
import { sync } from "../workflows/sync.js";
import { TemplateWriter, type Recipient } from "../workflows/writer.js";

const program = new Command("hub").description("Forefront Work Hub").option("--yes", "answer yes to every confirmation (careful)");

function hub(): Hub {
  const cfg = loadConfig();
  return makeHub(cfg, program.opts().yes ? new FixedApprover(true) : undefined);
}

async function done(h: Hub) {
  await h.homebase.close?.();
}

const num = (s: string) => {
  const n = Number.parseInt(s.replace(/^#/, ""), 10);
  if (!Number.isFinite(n)) throw new Error(`Not a job number: ${s}`);
  return n;
};

program
  .command("doctor")
  .description("Show how the hub is configured and which connectors are live or mocked")
  .action(() => {
    const h = hub();
    for (const l of describe(h)) console.log(l);
  });

program
  .command("jobs")
  .description("Your open reconstruction jobs from Homebase: stage, days in stage, last activity")
  .option("--all", "include closed jobs")
  .option("--mine", "only jobs where you're the estimator, PM or owner")
  .action(async (o) => {
    const h = hub();
    const jobs = await h.homebase.listJobs({ openOnly: !o.all, details: true, mine: o.mine ? h.cfg.homebase.me : undefined });
    const days = (d?: string) => (d ? Math.max(0, Math.floor((Date.now() - Date.parse(d)) / 864e5)) : undefined);
    const rows = jobs
      .map((j) => ({ ...j, inStage: days(j.stageSince), local: h.jobs.exists(j.jobNumber) ? h.jobs.get(j.jobNumber) : undefined }))
      .sort((a, b) => (b.inStage ?? -1) - (a.inStage ?? -1));
    for (const r of rows) {
      const est = r.local ? r.local.estimate.status : "-";
      const last = r.lastActivityAt ? `${days(r.lastActivityAt)}d ago` : "";
      const amt = r.proposalAmount ? `$${r.proposalAmount.toLocaleString("en-US", { minimumFractionDigits: 2 })}` : "";
      console.log(`#${String(r.jobNumber).padEnd(6)} ${r.name.slice(0, 22).padEnd(22)} ${r.stage.padEnd(19)} ${r.inStage !== undefined ? `${r.inStage}d`.padStart(4) : "    "}  ${amt.padStart(11)}  est:${est.padEnd(8)} ${(r.people?.estimator ?? "").padEnd(18)} ${last}`);
    }
    await done(h);
  });

program
  .command("pull <job>")
  .description("Refresh a job from Homebase into its folder; link CompanyCam and the DocuSketch sketch")
  .action(async (j) => {
    const h = hub();
    const job = await pullJob(h, num(j));
    console.log(`${h.jobs.folder(job.jobNumber)}\n${JSON.stringify({ stage: job.stage, customer: job.customer, adjuster: job.adjuster, carrier: job.carrier, claim: job.claimNumber }, null, 2)}`);
    await done(h);
  });

const jobCmd = program.command("job").description("Show or edit a job's job.json");
jobCmd
  .command("show <job>")
  .action((j) => {
    const h = hub();
    console.log(h.jobs.folder(num(j)));
    console.log(JSON.stringify(h.jobs.get(num(j)), null, 2));
  });
jobCmd
  .command("set <job>")
  .description("Fill in what Homebase doesn't have, e.g. --adjuster-email")
  .option("--customer-name <s>")
  .option("--customer-email <s>")
  .option("--adjuster-name <s>")
  .option("--adjuster-email <s>")
  .option("--adjuster-phone <s>")
  .option("--carrier <s>")
  .option("--claim <s>")
  .option("--date-of-loss <s>")
  .option("--insurance <claim|oop|unknown>")
  .option("--market <CODE8X|COBO8X>")
  .option("--total <n>", "estimate total (customer)", Number)
  .action((j, o) => {
    const h = hub();
    const n = num(j);
    const cur = h.jobs.get(n);
    const job = h.jobs.upsert(n, {
      customer: { name: o.customerName, email: o.customerEmail },
      adjuster: { name: o.adjusterName, email: o.adjusterEmail, phone: o.adjusterPhone },
      carrier: o.carrier,
      claimNumber: o.claim,
      dateOfLoss: o.dateOfLoss,
      insurance: o.insurance,
      market: o.market,
      estimate: o.total !== undefined ? { ...cur.estimate, total: o.total } : undefined,
      sendoff: o.total !== undefined ? { ...cur.sendoff, proposalAmount: o.total } : undefined,
    });
    console.log(JSON.stringify({ customer: job.customer, adjuster: job.adjuster, carrier: job.carrier, claim: job.claimNumber, insurance: job.insurance }, null, 2));
  });

program
  .command("photos <job>")
  .description("Download the job's CompanyCam photos into its photos/ folder")
  .action(async (j) => {
    const h = hub();
    await downloadPhotos(h, num(j));
  });

program
  .command("sendoff <job>")
  .description("Draft the send-off emails in Gmail (never sent), BCC'd to the job's Homebase address")
  .option("--to <who>", "homeowner, adjuster, or both", "both")
  .option("--cc <emails>", "comma-separated cc")
  .option("--template", "plain template wording instead of Claude + the skill (for testing)")
  .option("--reuse-photo-report", "attach the photo report already in estimate/ instead of building one")
  .action(async (j, o) => {
    const h = hub();
    const n = num(j);
    if (!h.jobs.exists(n)) await pullJob(h, n);
    const job = h.jobs.get(n);
    const to: Recipient[] = o.to === "both" ? (job.adjuster.email ? ["homeowner", "adjuster"] : ["homeowner"]) : (o.to.split(",") as Recipient[]);
    const useTemplate = o.template || h.cfg.mode === "mock" || !h.cfg.anthropicApiKey;
    const writer = useTemplate ? new TemplateWriter() : new (await import("../agent/writer.js")).AgentWriter(h);
    if (useTemplate) console.log("(template wording: mock mode, --template, or no API key)");
    await sendoff(h, n, { to, writer, cc: o.cc ? o.cc.split(",") : undefined, yes: program.opts().yes, reusePhotoReport: o.reusePhotoReport });
    await done(h);
  });

program
  .command("sync [job]")
  .description("For send-offs you've sent: update Homebase (proposal amount + send date, stage), asking first")
  .action(async (j) => {
    const h = hub();
    const res = await sync(h, j ? num(j) : undefined);
    for (const r of res) console.log(`#${r.jobNumber}: ${r.sent.length ? `sent ${r.sent.join(", ")}; ` : ""}${r.logged ? "logged in Homebase" : "not logged yet"}${r.note ? ` (${r.note})` : ""}`);
    if (!res.length) console.log("No send-offs to check.");
    await done(h);
  });

program
  .command("log <job> <kind> <text...>")
  .description("Log a call (Activity tab) or a note (Notes feed) on the Homebase job; asks first. kind: call | note")
  .option("--who <name>", "who the call was with")
  .option("--inbound", "an inbound call (default outbound)")
  .action(async (j, kind, text, o) => {
    if (!["call", "note"].includes(kind)) throw new Error("kind is call or note");
    const h = hub();
    const n = num(j);
    const body = text.join(" ");
    if (await h.approver.confirm(`Add this ${kind} to Homebase #${n}?`, [body])) {
      await h.homebase.addNote(n, { kind, body, who: o.who, direction: o.inbound ? "Inbound" : "Outbound" });
      if (h.jobs.exists(n)) h.jobs.log(n, `Homebase ${kind}: ${body.slice(0, 80)}`);
      console.log("Logged.");
    }
    await done(h);
  });

program
  .command("ask <request...>")
  .description('Ask the agent, e.g. hub ask "send Augustine\'s Xactimate and photos to the adjuster"')
  .option("-j, --job <n>", "the job this is about")
  .action(async (words, o) => {
    const h = hub();
    const { ask } = await import("../agent/run.js");
    await ask(h, words.join(" "), { jobNumber: o.job ? num(o.job) : undefined });
    await done(h);
  });

const hb = program.command("homebase").description("Homebase browser login and page snapshots");
hb.command("login")
  .description("Open a browser, log in to Homebase once, save the session")
  .action(async () => {
    const c = loadConfig();
    await new BrowserHomebase({ url: c.homebase.url, authFile: c.homebase.authFile, snapshotDir: `${c.hubRoot}/snapshots` }).login();
  });
hb.command("snapshot [job]")
  .description("Save the dashboard and a job page (HTML, text, screenshot) to snapshots/ for building the write steps")
  .action(async (j) => {
    const c = loadConfig();
    const b = new BrowserHomebase({ url: c.homebase.url, authFile: c.homebase.authFile, snapshotDir: `${c.hubRoot}/snapshots` });
    const files = await b.snapshot(j ? num(j) : undefined);
    await b.close();
    console.log(files.join("\n"));
  });

program
  .command("gmail")
  .description("Gmail setup")
  .command("login")
  .description("Connect Gmail (opens Google sign-in; drafts + read access only)")
  .action(async () => {
    const c = loadConfig();
    if (!c.gmail.clientId) throw new Error("Set GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET in .env first (see README).");
    await new GoogleGmail({ clientId: c.gmail.clientId, clientSecret: c.gmail.clientSecret, tokenFile: c.gmail.tokenFile, address: c.gmail.address }).login();
  });

const connect = program.command("connect").description("Guided set-up for a connection: gmail | companycam | maps");
connect.command("gmail").description("Connect Gmail step by step").action(async () => (await import("./connect.js")).connectGmail());
connect.command("maps").description("Connect Google Maps for drive times with traffic").action(async () => (await import("./connect.js")).connectGoogleMaps());
connect.command("companycam").description("Connect CompanyCam with an access token").action(async () => (await import("./connect.js")).connectCompanyCam());

program
  .command("mock-send <job>")
  .description("Mock mode only: pretend you sent the job's drafts (to try `hub sync`)")
  .action((j) => {
    const h = hub();
    if (!(h.gmail instanceof MockGmail)) throw new Error("Only for the mock Gmail");
    for (const d of h.jobs.get(num(j)).sendoff.drafts) if (!d.sentAt) h.gmail.markSent(d.id);
    console.log("Marked as sent.");
  });

program.parseAsync().catch((e) => {
  console.error(`\n${e.message ?? e}`);
  process.exit(1);
});

