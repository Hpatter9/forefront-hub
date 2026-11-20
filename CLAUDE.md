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
  Written by also offers Gemini 4 Hydrogen and Argon by name (`GEMINI_CHOICES` in `src/agent/studio.ts`; ids overridable
  with GEMINI_HYDROGEN_MODEL / GEMINI_ARGON_MODEL): a named model runs alone, with no fallback model.
- The sub work order (`src/workflows/subReport.ts`, laid out by `scripts/sub_report.py`) is written by the everyday
  AI (Gemini) from the estimate with prices stripped, the walk transcripts, notes and photos. It never shows a price,
  and anything the sources don't settle (which walls, color) is printed as NOT SETTLED and returned as a question.
- Keeping Claude cheap and estimates right: `job_review` (`src/workflows/dossier.ts`) hands the estimator a digest made
  by Gemini (`src/workflows/jobDigest.ts`: emails/texts boiled down, a line per photo plus saved contact sheets) instead
  of every original, falling back to originals if Gemini fails. After any estimate change, `src/workflows/estimateCheck.ts`
  checks it without Claude (prices vs the skill's price files, quantities vs room sizes, Gemini read-through vs sources).
  New everyday features go to Gemini; only writing the estimate itself may use Claude.
- Hunter's Claude subscription can't run inside Keystone (Agent SDK apps need the API). The subscription route is the
  hand-off to the Claude app (`src/workflows/claudeHandoff.ts`): Keystone fills `<job>/for-claude/` with a job brief
  and the files, he drags them into Claude, and drops the results back. It's the Estimator's default "Written by".
  Better still, `Keystone for Claude.mcpb` (packed from `mcpb/` by `scripts/build-mcpb.py`; rebuild after editing) installs
  `mcpb/server/index.cjs` as a local MCP server in the Claude desktop app (`Connect Claude app` writes the config file too); it
  proxies tool calls to the running Keystone (`src/server/claudeBridge.ts`), so Claude reads the job, runs the skill's
  scripts and saves results itself. Bridge tools are estimating only; the Claude app's tool prompt is the approval.
  `.mcp.json` offers the same helper to Claude Code sessions opened on this folder (the desktop app's Code tab doesn't
  load extensions).
- Updates on Hunter's PC: `scripts/update.mjs` runs first in `npm run app` (so it runs however Keystone is launched),
  fast-forwards to origin/main, keeps hand edits that don't clash and stashes ones that do, and never blocks the start.
  It then does the same for the Estimator folder
  (`ESTIMATOR_DIR`), following GitHub's default branch, so skill changes reach the PC (a downloaded, non-git folder is
  turned into a git copy, with changed files stashed and `data/` left alone). It only acts on Windows (or `KEYSTONE_UPDATE=1`), so a developer's copy is left alone. The app shows the running
  version and an "Update ready" chip (`src/server/version.ts`); exit code 75 means "restart me" to `Start Keystone.bat`.
- Before every brief, `src/workflows/autopilot.ts` does what Keystone can itself (Gemini only, draft-only tools):
  closes tasks already done, drafts replies/follow-ups/check-ins/walk-booking emails and email-only tasks, and queues
  Homebase steps as Yes/No cards; the brief lists only what's left, grouped. Task titles are "Job name - what to do"
  (`src/workflows/taskTitle.ts`, job number in the notes). A brief line that is a Google Task takes its ticked state
  from Google, so a tick anywhere shows everywhere.
- ITEL reports (`src/workflows/itel.ts`): the job review searches the job's email for them, saves PDFs to
  `files/ITEL/` with a Gemini summary (material, rooms, matched product, unit price, installed or not), and the
  estimators are pointed at the skill's "ITEL pricing" rule (in the skill, not here). The free check validates
  `price_source: "itel"` lines against the reports.
- API budget (`src/workflows/spend.ts`, chip + panel at the top of the page): every Claude run's `total_cost_usd`
  and every Gemini answer's tokens (`MeteredGemini`, priced at editable per-model rates) are tallied per month in
  `.hub/spend.json`; Hunter sets a monthly budget per provider and sees what's left. No API reports prepaid credit
  left. With `ANTHROPIC_ADMIN_KEY` the panel also shows Anthropic's own month-to-date cost
  (`src/connectors/anthropicCost`, cost analytics API) and uses the larger figure. Past the Claude budget, the
  Estimator asks before a paid Claude run. Record the cost of any new Claude or Gemini call path the same way.
- Every Estimator writer can make Gmail drafts (never send): Claude through the hub tools, Gemini (all models) via
  `gmail_create_draft` in `HUB_TOOLS`, the Claude app via `keystone_create_draft` on the bridge.
- Proposal Submitted status (`src/workflows/statusUpdates.ts`): the "Proposal Submitted Notes" card on a recon job's
  Dashboard is Homebase's hold-notes (`GET/POST /projects/:id/hold-notes`; its own list, not job notes; POST only on a
  Reconstruction job at Proposal Submitted). Keystone ADDS a dated one- or two-sentence current status there for
  coworkers and never deletes or edits older notes (Hunter's call). Gemini writes it from the job's timeline, only when
  something new happened; one card OKs every job's note ("Williams: new text" / "skip Williams" in the reply box).
  Runs a few minutes after the first start of the day and after the morning brief; also the Dashboard's Update
  Homebase notes button, the `homebase_status_updates` / `homebase_set_status_update` tools and POST
  /api/status-updates. The older field-based path stays only for a Homebase connection without the card.
- Question cards take a typed answer as well as Yes/No (`#ap-reply`). `confirm` treats a typed answer as no and the
  page sends it to the Ask box as an instruction; callers that can use it call `confirmOrReply` (e.g. the status
  card: "Williams: new text" or "skip Williams").
- Game mode (switch in the corner controls; per browser, `localStorage hub:game:*`): `src/server/game.js` restyles
  the page (pixel fonts, starfield, RPG dialogs, tabs renamed HQ/Quests/World Map/The Forge/...), adds a HUD, a Quest
  Board on the dashboard, a World Map level path on jobs, pop-ups, level-up/boss screens and optional WebAudio sounds
  (off by default). Icons/badges are hand-drawn text grids inside game.js; the builder, bosses, town buildings and town
  music come from Hunter's Little Town game (only its own art) via `scripts/build-game-art.py` into `src/server/game-art/`
  (served at /game-art/, credits in its CREDITS.md). The town grows one building per level. Scoring is
  `src/workflows/game.ts` via GET /api/game: XP only from what Keystone already records (job log lines matched by
  `RULES`, estimate PDFs rendered, brief ticks), each event counted once by id into `.hub/game.json`, with daily caps;
  quests, a boss (longest-waiting job; actions on it are hits; beaten when it leaves the waiting list), badges,
  streak. It never changes what Keystone does. New kinds of work: add a RULES line for the job-log text they write.
- iPhone auto-backup (`src/workflows/autoBackup.ts`, `src/connectors/iphoneBackup`): every 5 minutes, if a phone is
  plugged in by cable and the newest backup is over 3 hours old, Keystone runs `pymobiledevice3 backup2 backup` (a
  private venv in `.hub/iphone-tools`, installed on first use) into the folder Apple Devices uses. Clicking the Texts
  chip does it now (POST /api/texts/backup). IPHONE_AUTO_BACKUP=off turns it off. Untested against a real phone on
  Windows when written: failures are said once and retried hourly; Apple Devices' Back Up Now is the fallback.
- Drive hand-off (`src/workflows/driveHandoff.ts`, `src/connectors/drive`): for writing estimates in a Claude chat that
  can't see the PC (Claude Code on the web). "Send to Claude chat" on the Estimator's hand-off panel uploads the
  hand-off package plus Request.md to Google Drive "Keystone hand-off/<job# name>/for-claude"; Claude saves PDFs and
  estimate.json in ".../from-claude"; Keystone checks every 2 minutes (or "Get what Claude made"), asks before
  replacing an estimate (old one to estimate/revisions) and runs the free check. The root folder lives in Hunter's
  personal Drive and is shared with Keystone's Google account, hence the full `drive` scope (re-run Connect Gmail).
- Everyday Gemini work only runs on free Flash models (`FREE_GEMINI`, `isFreeGemini` in `src/core/config.ts`): a
  heavier GEMINI_MODEL / GEMINI_FAST_MODEL in .env is ignored (shown in the status line), fallbacks always end with
  the free list, and the connector moves to the next model on any failure except a bad key. Heavy models run only
  when picked by name in the Estimator.
- Two Gemini keys (`TieredGemini` in `src/connectors/gemini`): GEMINI_FREE_API_KEY runs everyday work; GEMINI_API_KEY
  (paid) is used only when the free key can't answer (said once a day; GEMINI_PAID_FALLBACK=off stops it) and for
  models picked by name (`paid: true`). Only the paid key's use is metered as spending. `Connect Gemini` asks F or P
  and saves the right variable. With one key, everything works as before.

