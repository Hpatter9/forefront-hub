# Keystone

One place to run a reconstruction job end to end: Homebase, Gmail, CompanyCam and DocuSketch behind a Claude agent
that uses the **forefront-estimate** skill for all estimating. This is phase 1: a command-line tool. The desktop app
comes next and uses the same code.

```
npm run app                                Keystone's screen at http://localhost:4317: Dashboard, Jobs, Estimator, Gmail, Calendar (+ Google Tasks), Music
hub jobs --mine                            my open recon jobs: stage, days in stage, proposal $, estimator
hub pull 3226                              Homebase -> C:\Jobs\3226 Augustine\job.json, link CompanyCam + DocuSketch
hub photos 3226                            CompanyCam photos -> photos\
hub sendoff 3226 --to adjuster             Gmail drafts (never sent), right PDFs, BCC office+3226@...
hub sync                                   after you hit Send: proposal $ + date + stage in Homebase (asks first)
hub log 3226 call "Left VM" --who Eileen   call on the job's Activity tab, or a note (asks first)
hub ask -j 3226 "estimate this from the ESX and photos"     anything else, through the agent
```

Nothing is ever emailed by Keystone: it only makes **drafts**. Anything that changes Homebase, or overwrites an
estimate, asks you first; old estimates are kept in `estimate\revisions\vN`.

## Setup (Windows)

Double-click **Setup Keystone.bat** (it can sit in Downloads). It:
- installs Git and Node.js if they're missing;
- downloads Keystone to `C:\Games\forefront-hub` (sign in to GitHub if asked);
- updates the Estimator;
- installs Keystone;
- asks once for your Homebase API key;
- adds a **Keystone** icon to your desktop.

Run it again any time; it only fills in what's missing. The icon starts Keystone and opens http://localhost:4317, and
it picks up the latest version each time.

Settings live in `C:\Games\forefront-hub\.env` (never uploaded). The Claude key is read from the Estimator app's
saved key. Gmail and CompanyCam are connected later (below); until then those parts run on stand-ins.

### Gmail: a Google OAuth client (one time, ~10 minutes)

Keystone talks to Gmail directly, so it needs its own Google "OAuth client". Claude's Gmail connector can't be used
from a program on your PC.

1. Go to https://console.cloud.google.com, signed in as hunter@forefrontteam.com. Create a project named
   "Keystone".
2. **APIs & Services → Library**: search for **Gmail API** and click **Enable**.
3. **APIs & Services → OAuth consent screen** (also called "Google Auth Platform → Branding/Audience"):
   - App name "Keystone", your email as the support and contact address.
   - Audience/User type: **Internal**. This is only offered on Google Workspace accounts, and it means no Google
     review and no 7-day token expiry. If Internal is greyed out, ask whoever runs Forefront's Google Workspace.
     The fallback is External plus yourself as a test user, but then you'll redo `gmail login` every 7 days.
4. **Credentials → Create credentials → OAuth client ID → Application type: Desktop app**, named "Keystone".
   Copy the **Client ID** and **Client secret** into `.env`.
5. Run `npm run hub -- gmail login`. Keystone asks only for *compose* (create drafts) and *read* access. It has
   no permission to send.

### CompanyCam token

Your CompanyCam connector in Claude works in claude.ai, but Keystone needs its own token. In the CompanyCam web
app, an admin can create an **access token** (Company settings → Integrations / API → Access Tokens; the exact
menu name varies with the plan). Paste it into `COMPANYCAM_TOKEN`. If you can't find it, ask CompanyCam support
for "a v2 API access token".

### DocuSketch

DocuSketch has no API. Keystone finds the "Sketch request … delivered" email for the job to learn the DocuSketch
project ID. You download the ESX from the portal as usual, and Keystone picks `<project id>*.ESX` up from your
Downloads folder (`DOWNLOADS_DIR`) into the job's `sketch\` folder.

## Job folders

```
C:\Jobs\3226 Augustine\
  job.json        Homebase facts + CompanyCam/DocuSketch links + send-off drafts + log (Keystone and agent both use it)
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
  the skill itself from `ESTIMATOR_DIR\skill\forefront-estimate`, linked into `.claude\skills`. Keystone never
  prices or scopes anything.
- `src/workflows`: the send-off and sync, as plain code with two judgment calls (email wording, photo picks) made
  by Claude with the skill (`src/agent/writer.ts`).
- `src/agent`: the Claude Agent SDK setup. `tools.ts` holds Keystone's tools (Homebase writes ask first, and there is
  no send tool). `guard.ts` limits file writes to job folders and asks before an estimate is overwritten.

- The **Estimator** tab (`src/agent/studio.ts`) is a chat with Claude per job, like using the skill in a chat:
  estimates, agreements with selections, the Material Selection Approval sheet (`render.py --only selections`),
  photo reports and revisions. Each job keeps its conversation in `notes\estimator-chat.json`, and follow-ups resume
  the same Claude session. Files dropped into the chat go into the job folder; the job's documents are listed
  beside the chat with a preview.

- **Property management jobs**: when a job's Homebase account is a property manager or HOA, the management
  company is the customer (`customerFor` in `src/workflows/pull.ts`): its name on documents, its person and email
  for the send-off (a Billing contact at the company first, else the account's billing email). A primary contact
  who isn't at the company (owner or tenant) is kept as the on-site contact only and never emailed estimates.

- **Morning brief**: Plan my day runs on its own at 7:00 AM Denver time on weekdays and shows as Today's brief on
  the dashboard (`src/workflows/brief.ts`). If Keystone opens later, it runs then (until 5 PM). Change it in `.env`:
  `HUB_BRIEF_TIME=08:00`, `HUB_BRIEF_DAYS=0-6` (every day), or `HUB_BRIEF_TIME=off`.
  Only your own, recent action items go in (`briefItems` in `src/workflows/reminders.ts`): emails count as waiting
  on a reply only when you're on the To line (not just Cc'd) and they're under 21 days old (`HUB_REPLY_DAYS`); a
  street name only ties an email to a job when it's in the subject; quiet jobs in production or billing stages
  (the PM's) stay out, and so does anything old (it still shows on the dashboard). Every View email button is
  checked against its job before the brief shows (`src/workflows/briefEmails.ts`): a wrong one is swapped for the
  job's own waiting email, or removed.

- **Drive times**: calendar events with an address show a "leave by" block, the drive time from the previous
  appointment (or the office, or `HUB_DAY_START_ADDRESS`), and a warning when back-to-back visits don't leave
  enough time (`src/workflows/travel.ts`, `src/connectors/travel`). Free, no key: OpenStreetMap
  times the drive, padded 20% for traffic and 45% at weekday rush hour.

- **Which AI**: `HUB_AI=gemini | claude | off` in `.env` (`src/agent/llm.ts`). With a `GEMINI_API_KEY` (double-click
  **Connect Gemini**) Keystone's AI features run on Google's Gemini: summaries and tasks from email on the lite
  model, the brief and Ask on `GEMINI_MODEL` (gemini-3.5-flash) using Keystone's own tools by function calling,
  with fallback models when one is busy. Only the Estimator tab uses the paid Claude API (`ANTHROPIC_API_KEY`,
  sk-ant-...), where Claude runs the estimating skill and its scripts. Everything else runs on Gemini (free): the
  send-off email wording and the adjuster report's photo picks (following the skill's step 6, read from SKILL.md,
  looking at the skill's photo_sheets.py contact sheets), and setting up selections (Gemini reads the estimate;
  budgets come from the estimate's allowances or the skill's price_lookup.py --components). An
  Anthropic key alone never turns Claude on for everyday features (`HUB_AI=claude` is a deliberate opt-in). Keystone
  takes that key from its own `.env` first, then the Estimator app, then the PC, and ignores PC-wide redirects
  such as `ANTHROPIC_BASE_URL` set by ChatGPT bridges (`src/agent/env.ts`; `HUB_ALLOW_CLAUDE_REDIRECT=1` keeps them). On Gemini's free tier Google may use requests to improve its products.

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
| Estimator tab (chat with Claude + skill, document checklist, PDF preview) | done; tested end to end with Claude in the cloud preview |
| Desktop app wrapper | next: Electron window around the same screen |
