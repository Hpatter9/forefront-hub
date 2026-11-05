# Forefront Work Hub

One place to run a reconstruction job end to end: Homebase, Gmail, CompanyCam and DocuSketch behind a Claude agent
that uses the **forefront-estimate** skill for all estimating. This is phase 1: a command-line tool. The desktop app
comes next and uses the same code.

```
npm run app                                the hub's screen at http://localhost:4317 (job list, job page, Ask Claude)
hub jobs --mine                            my open recon jobs: stage, days in stage, proposal $, estimator
hub pull 3226                              Homebase -> C:\Jobs\3226 Augustine\job.json, link CompanyCam + DocuSketch
hub photos 3226                            CompanyCam photos -> photos\
hub sendoff 3226 --to adjuster             Gmail drafts (never sent), right PDFs, BCC office+3226@...
hub sync                                   after you hit Send: proposal $ + date + stage in Homebase (asks first)
hub log 3226 call "Left VM" --who Eileen   call on the job's Activity tab, or a note (asks first)
hub ask -j 3226 "estimate this from the ESX and photos"     anything else, through the agent
```

Nothing is ever emailed by the hub: it only makes **drafts**. Anything that changes Homebase, or overwrites an
estimate, asks you first; old estimates are kept in `estimate\revisions\vN`.

## Setup (Windows)

1. Install **Node.js 22 LTS** from nodejs.org. Python is already there from `Setup Estimator.bat`.
2. Clone this repo next to the estimator, e.g. `C:\Games\forefront-hub`, then in that folder:
   ```
   npm install
   copy .env.example .env
   ```
3. Edit `.env`:
   - `ESTIMATOR_DIR=C:\Games\Estimator` and `JOBS_ROOT=C:\Jobs`.
   - `ANTHROPIC_API_KEY`: leave it blank to reuse the key saved in the Estimator app (`data\api_key.txt`).
   - `HOMEBASE_API_TOKEN`: your Homebase API key (Homebase → Settings → API keys, starts with `hbk_`).
   - `COMPANYCAM_TOKEN`: see below.
   - `GOOGLE_CLIENT_ID` and `GOOGLE_CLIENT_SECRET`: see below.
4. Connect:
   ```
   npm run hub -- doctor           shows what's live and what's still mocked
   npm run hub -- gmail login      Google sign-in; allow drafts + read
   ```

Leave a setting blank and that piece runs on its mock, so the hub works before everything is connected.
`HUB_MODE=mock` runs everything on mocks (drafts go to `.hub\outbox\*.eml`).

### Gmail: a Google OAuth client (one time, ~10 minutes)

The hub talks to Gmail directly, so it needs its own Google "OAuth client". Claude's Gmail connector can't be used
from a program on your PC.

1. Go to https://console.cloud.google.com, signed in as hunter@forefrontteam.com. Create a project named
   "Forefront Hub".
2. **APIs & Services → Library**: search for **Gmail API** and click **Enable**.
3. **APIs & Services → OAuth consent screen** (also called "Google Auth Platform → Branding/Audience"):
   - App name "Forefront Hub", your email as the support and contact address.
   - Audience/User type: **Internal**. This is only offered on Google Workspace accounts, and it means no Google
     review and no 7-day token expiry. If Internal is greyed out, ask whoever runs Forefront's Google Workspace.
     The fallback is External plus yourself as a test user, but then you'll redo `gmail login` every 7 days.
4. **Credentials → Create credentials → OAuth client ID → Application type: Desktop app**, named "Forefront Hub".
   Copy the **Client ID** and **Client secret** into `.env`.
5. Run `npm run hub -- gmail login`. The hub asks only for *compose* (create drafts) and *read* access. It has
   no permission to send.

### CompanyCam token

Your CompanyCam connector in Claude works in claude.ai, but the hub needs its own token. In the CompanyCam web
app, an admin can create an **access token** (Company settings → Integrations / API → Access Tokens; the exact
menu name varies with the plan). Paste it into `COMPANYCAM_TOKEN`. If you can't find it, ask CompanyCam support
for "a v2 API access token".

### DocuSketch

DocuSketch has no API. The hub finds the "Sketch request … delivered" email for the job to learn the DocuSketch
project ID. You download the ESX from the portal as usual, and the hub picks `<project id>*.ESX` up from your
Downloads folder (`DOWNLOADS_DIR`) into the job's `sketch\` folder.

## Job folders

```
C:\Jobs\3226 Augustine\
  job.json        Homebase facts + CompanyCam/DocuSketch links + send-off drafts + log (the hub and agent both use it)
  sketch\         *.ESX
  photos\         CompanyCam photos + index.json (dates, descriptions) + report-picks.json
  estimate\       estimate.json, "<Last> - Reconstruction Estimate / Agreement / Xactimate Estimate / Photo Report.pdf"
    revisions\v1  previous versions, saved automatically before an overwrite
  email\          copy of each drafted email
  notes\          notes.txt
```

## How it fits together

- `src/connectors/*`: one folder per outside system, each with a small interface (`types.ts` / top of
  `index.ts`), a **mock** and a live version. Homebase uses its real API ([docs/homebase-api.md](docs/homebase-api.md));
  a browser driver (`HOMEBASE_DRIVER=browser`) remains as a fallback.
- `src/connectors/skill`: runs the forefront-estimate skill's own scripts (totals, photo report). The agent loads
  the skill itself from `ESTIMATOR_DIR\skill\forefront-estimate`, linked into `.claude\skills`. The hub never
  prices or scopes anything.
- `src/workflows`: the send-off and sync, as plain code with two judgment calls (email wording, photo picks) made
  by Claude with the skill (`src/agent/writer.ts`).
- `src/agent`: the Claude Agent SDK setup. `tools.ts` holds the hub tools (Homebase writes ask first, and there is
  no send tool). `guard.ts` limits file writes to job folders and asks before an estimate is overwritten.

`npm test` runs everything on mocks, including the skill's real Python scripts (it expects the estimator repo
next to this one, or `ESTIMATOR_DIR`). `npm run typecheck` checks types.

## Status

| Piece | State |
|---|---|
| Job folders, approvals, CLI, send-off, sync | done, tested on mocks |
| Gmail (drafts with real attachments, signature, sent detection, search) | written; first real run is `gmail login` |
| CompanyCam (find project, photos, download) | written against the v2 API |
| DocuSketch (delivery email → project ID → ESX from Downloads) | written |
| Homebase reads (jobs, job, notes) | **working against the live API** (`hub jobs --mine`, `hub pull 3226`) |
| Homebase writes (proposal, stage, call/note) | written to the API reference and tested against a fake; first real write is your first `hub sync` |
| Agent (`hub ask`, Claude-written send-off emails) | written; needs the API key on your PC |
| Screen (`npm run app`) | job list, job page (Homebase, emails, activity, notes, estimate files, drafts), send-off / sync / log buttons with approval pop-ups, Ask Claude box |
| Desktop app wrapper | next: Electron window around the same screen |
