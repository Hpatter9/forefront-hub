# Keystone: notes for Claude

- TypeScript (ESM, Node 22), run with `tsx`; `npm test` (vitest) and `npm run typecheck` must pass before pushing.
- Every outside system lives in `src/connectors/<name>` behind a small interface with a mock. Nothing outside a
  connector imports a live client directly; use `makeHub()` / the `Hub` object.
- Never add estimating logic here. Scoping, pricing, customer wording, the email voice and the photo report rules
  live in the `forefront-estimate` skill in the Hpatter9/estimator repo (`skill/forefront-estimate`). Keystone runs
  its scripts or lets the agent load the skill.
- Keystone never sends email; Gmail is drafts-only. Homebase writes and estimate overwrites go through
  `hub.approver.confirm`. Homebase's proposal amount and date are written together, and only by `sync` after a
  draft has been sent (or by an explicit, confirmed request).
- Test data is fictional (fixtures/). Don't commit real customer data, Homebase snapshots, `.env` or `auth/`.
- Tests expect the estimator repo at `../estimator` (or `ESTIMATOR_DIR`) and `python3` with reportlab, pdfplumber
  and Pillow.
- `phone/` is the Android app (a WebView shell in Java plus `assets/index.html` and `assets/app.js`; no Gradle, built
  by `phone/build.sh` with Google's build-tools). It works without the laptop: it calls Homebase, Google and Gemini
  itself with keys handed over once by `Connect phone` (`src/workflows/phone.ts`). Same rules as here: writes ask
  first, email is drafts only. `phone/keystone.apk` is the built app. Its signing key is `phone/signing/keystone.jks`,
  kept in the repo at Hunter's request so every update installs over the last one: always build with it, and raise
  `versionCode` in `phone/AndroidManifest.xml` with each release.
- The shop's overstock is the newest `.xlsx` in `inventory/` on the PC (git-ignored: its notes can name customers),
  read by `src/workflows/inventory.ts`. Keystone only reminds (job page card, `shop_stock` tool, a line in the AI's
  instructions); it never puts stock on an estimate itself.
- The Estimator can be written by Claude (Agent SDK + the skill) or, as a trial, by Gemini (`src/agent/geminiEstimator.ts`):
  Gemini gets SKILL.md word for word plus narrow tools (read/list/view/write in the job folder, run the skill's own
  scripts). No estimating rules live in Keystone either way; the same overwrite guard applies to both.
- The sub work order (`src/workflows/subReport.ts`, laid out by `scripts/sub_report.py`) is written by the everyday
  AI (Gemini) from the estimate with prices stripped, the walk transcripts, notes and photos. It never shows a price,
  and anything the sources don't settle (which walls, color) is printed as NOT SETTLED and returned as a question.
- Keeping Claude cheap and estimates right: `job_review` (`src/workflows/dossier.ts`) hands the estimator a digest made
  by Gemini (`src/workflows/jobDigest.ts`: emails/texts boiled down, a line per photo plus saved contact sheets) instead
  of every original, falling back to originals if Gemini fails. After any estimate change, `src/workflows/estimateCheck.ts`
  checks it without Claude (prices vs the skill's price files, quantities vs room sizes, Gemini read-through vs sources).
  New everyday features go to Gemini; only writing the estimate itself may use Claude.
