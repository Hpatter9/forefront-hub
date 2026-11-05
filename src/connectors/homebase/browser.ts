import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { createInterface } from "node:readline/promises";
import type { Browser, BrowserContext, Page } from "playwright";
import { parseDashboard, parseJobPage, findStage, type PageLink } from "./parse.js";
import type { HomebaseClient, JobDetail, JobSummary } from "./types.js";

/**
 * Homebase driven through a real browser with Hunter's own login, until Homebase has an API.
 *
 * `hub homebase login` opens a window, you log in once, and the session is saved to auth/homebase.json.
 * Reads parse the server-rendered pages. Writes fill the same forms you would and then reload the page to
 * check the change stuck; if a form can't be found they stop with an error instead of guessing.
 *
 * The write selectors are written from page snapshots (`hub homebase snapshot <job#>`). Until they've been
 * checked against the real pages, every write asks first (the approval gate) and verifies after.
 */
export class BrowserHomebase implements HomebaseClient {
  readonly kind = "browser" as const;
  private browser?: Browser;
  private ctx?: BrowserContext;
  private index?: Map<number, JobSummary>;

  constructor(private opts: { url: string; authFile: string; snapshotDir: string; headed?: boolean }) {}

  // ---------------------------------------------------------------- session

  private async context(): Promise<BrowserContext> {
    if (this.ctx) return this.ctx;
    if (!existsSync(this.opts.authFile)) throw new Error("Not logged in to Homebase. Run: npm run hub -- homebase login");
    this.browser = await launch(!this.opts.headed);
    this.ctx = await this.browser.newContext({ storageState: this.opts.authFile });
    return this.ctx;
  }

  private async open(urlPath: string): Promise<Page> {
    const page = await (await this.context()).newPage();
    await page.goto(new URL(urlPath, this.opts.url).toString(), { waitUntil: "domcontentloaded" });
    if (/\/(login|sign_in|signin|users\/sign_in)/i.test(page.url()) || (await page.locator("input[type=password]").count()) > 0) {
      await page.close();
      throw new Error("Homebase login has expired. Run: npm run hub -- homebase login");
    }
    return page;
  }

  /** Opens a visible browser at Homebase; you log in, press Enter here, and the session is saved. */
  async login(): Promise<void> {
    const browser = await launch(false);
    const ctx = await browser.newContext(existsSync(this.opts.authFile) ? { storageState: this.opts.authFile } : {});
    const page = await ctx.newPage();
    await page.goto(this.opts.url);
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    await rl.question("Log in to Homebase in the browser window, then press Enter here... ");
    rl.close();
    mkdirSync(path.dirname(this.opts.authFile), { recursive: true });
    await ctx.storageState({ path: this.opts.authFile });
    await browser.close();
    console.log(`Saved Homebase login to ${this.opts.authFile}`);
  }

  /** Saves the dashboard and a job page (HTML + screenshot + text) so the write selectors can be written from them. */
  async snapshot(jobNumber?: number): Promise<string[]> {
    mkdirSync(this.opts.snapshotDir, { recursive: true });
    const out: string[] = [];
    const save = async (page: Page, name: string) => {
      const base = path.join(this.opts.snapshotDir, name);
      writeFileSync(`${base}.html`, await page.content());
      writeFileSync(`${base}.txt`, await page.locator("body").innerText());
      await page.screenshot({ path: `${base}.png`, fullPage: true });
      out.push(`${base}.html`);
    };
    const dash = await this.open("/departments/reconstruction");
    await save(dash, "dashboard");
    await dash.close();
    if (jobNumber) {
      const job = await this.summary(jobNumber);
      const page = await this.open(job.url);
      await save(page, `job-${jobNumber}`);
      // Open each edit control we can find (without saving) so its form is in the snapshot too.
      for (const label of [/edit/i, /financial/i, /stage/i, /add note|new note/i]) {
        const btn = page.getByRole("button", { name: label }).first();
        if (await btn.count()) {
          await btn.click().catch(() => {});
          await page.waitForTimeout(500);
          await save(page, `job-${jobNumber}-${label.source.replace(/\W+/g, "_")}`);
          await page.keyboard.press("Escape").catch(() => {});
        }
      }
      await page.close();
    }
    return out;
  }

  // ---------------------------------------------------------------- reads

  async listJobs(filter: { openOnly?: boolean } = {}): Promise<JobSummary[]> {
    const page = await this.open("/departments/reconstruction");
    const jobs = parseDashboard(await links(page), this.opts.url);
    await page.close();
    this.index = new Map(jobs.map((j) => [j.jobNumber, j]));
    const closed = new Set(["Payment Received", "Closed Lost"]);
    return jobs.filter((j) => !filter.openOnly || !closed.has(j.stage));
  }

  private async summary(jobNumber: number): Promise<JobSummary> {
    if (!this.index?.has(jobNumber)) await this.listJobs();
    const hit = this.index!.get(jobNumber);
    if (!hit) throw new Error(`Job #${jobNumber} isn't on the reconstruction dashboard.`);
    return hit;
  }

  async getJob(jobNumber: number): Promise<JobDetail> {
    const s = await this.summary(jobNumber);
    const page = await this.open(s.url);
    const detail = parseJobPage(await page.locator("body").innerText(), await links(page), page.url());
    await page.close();
    return { ...s, ...detail, jobNumber, stage: detail.stage || s.stage, address: detail.address || s.address, name: s.name || detail.name };
  }

  // ---------------------------------------------------------------- writes

  async setProposal(jobNumber: number, p: { amount: number; submittedAt: string }): Promise<void> {
    if (!(p.amount > 0) || !p.submittedAt) throw new Error("setProposal needs both an amount and a submitted date");
    await this.edit(jobNumber, async (page) => {
      await fillField(page, /proposal\s*(amount)?$/i, p.amount.toFixed(2));
      await fillField(page, /proposal\s*(submitted|date)|submitted\s*date/i, p.submittedAt.slice(0, 10));
    });
    const after = await this.getJob(jobNumber);
    if (Math.abs((after.proposalAmount ?? 0) - p.amount) > 0.005) {
      throw new Error(`Homebase didn't take the proposal amount (shows ${after.proposalAmount ?? "nothing"}). Check the job page.`);
    }
  }

  async setContractAmount(jobNumber: number, amount: number): Promise<void> {
    await this.edit(jobNumber, (page) => fillField(page, /contract\s*(amount)?$/i, amount.toFixed(2)));
  }

  async setStage(jobNumber: number, stage: string): Promise<void> {
    const s = await this.summary(jobNumber);
    const page = await this.open(s.url);
    const select = page.locator("select").filter({ has: page.locator(`option:text-is("${stage}")`) }).first();
    if (!(await select.count())) {
      await page.close();
      throw new Error("Couldn't find the stage control on the job page. Send me `hub homebase snapshot` output.");
    }
    await select.selectOption({ label: stage });
    await submitNear(page, select);
    await page.close();
    const after = await this.getJob(jobNumber);
    if (findStage(after.stage) !== stage) throw new Error(`Stage still shows "${after.stage}" after setting "${stage}".`);
  }

  async addNote(jobNumber: number, note: { kind: "note" | "call"; body: string }): Promise<void> {
    const s = await this.summary(jobNumber);
    const page = await this.open(s.url);
    const box = page.locator("textarea").first();
    if (!(await box.count())) {
      await page.close();
      throw new Error("Couldn't find the notes box on the job page. Send me `hub homebase snapshot` output.");
    }
    const body = note.kind === "call" ? `Call: ${note.body}` : note.body;
    await box.fill(body);
    await submitNear(page, box);
    await page.waitForLoadState("domcontentloaded");
    const text = await page.locator("body").innerText();
    await page.close();
    if (!text.includes(body.slice(0, 40))) throw new Error("The note didn't appear on the job page after saving.");
  }

  private async edit(jobNumber: number, fill: (page: Page) => Promise<void>) {
    const s = await this.summary(jobNumber);
    const page = await this.open(s.url);
    const edit = page.getByRole("button", { name: /edit/i }).or(page.getByRole("link", { name: /edit/i })).first();
    if (await edit.count()) await edit.click();
    await fill(page);
    await page.getByRole("button", { name: /save|update|submit/i }).first().click();
    await page.waitForLoadState("domcontentloaded");
    await page.close();
  }

  async close() {
    await this.browser?.close();
  }
}

async function launch(headless: boolean): Promise<Browser> {
  const { chromium } = await import("playwright");
  // On Windows use the installed Edge so nothing has to be downloaded; elsewhere Playwright's Chromium.
  const channel = process.env.HOMEBASE_BROWSER_CHANNEL || (process.platform === "win32" ? "msedge" : undefined);
  return chromium.launch({ headless, channel });
}

async function links(page: Page): Promise<PageLink[]> {
  return page.$$eval("a[href]", (as) =>
    as.map((a) => {
      const row = a.closest("tr, li, article, .card, [class*=card], [class*=row]") ?? a.parentElement;
      return { href: (a as HTMLAnchorElement).href, text: a.textContent ?? "", rowText: (row as HTMLElement | null)?.innerText ?? "" };
    }),
  );
}

async function fillField(page: Page, label: RegExp, value: string) {
  const field = page.getByLabel(label).first();
  if (!(await field.count())) throw new Error(`Couldn't find a "${label.source}" field on the job page. Send me \`hub homebase snapshot\` output.`);
  await field.fill(value);
}

async function submitNear(page: Page, el: ReturnType<Page["locator"]>) {
  const form = el.locator("xpath=ancestor::form[1]");
  const btn = (await form.count())
    ? form.locator("button[type=submit], input[type=submit], button").first()
    : page.getByRole("button", { name: /save|update|add|post|submit/i }).first();
  if (await btn.count()) await btn.click();
  else await el.press("Enter");
  await page.waitForLoadState("domcontentloaded");
}
