# Homebase API: what the hub uses

Homebase has a real JSON API at `https://homebase.forefrontteam.com/api/v1`. The full reference is
`GET /api/v1/docs` (needs a key). Keys are minted in Homebase under **Settings → API keys**. The hub's key goes in
`.env` as `HOMEBASE_API_TOKEN` and is never committed.

The hub's driver is `src/connectors/homebase/api.ts`. It sends the key as `Authorization: Bearer`,
`X-Acting-User-Email: hunter@forefrontteam.com` so writes are stamped as Hunter, and an `Idempotency-Key` on every write.

| Hub action | Route |
|---|---|
| `hub jobs` (open recon jobs) | `GET /projects?department=reconstruction&active=1`, then `GET /projects/:id` for days in stage, estimator, proposal $ |
| `hub pull <job#>` | `GET /projects?q=<job#>` → `GET /projects/:id` (contacts, `brief.adjuster1/2`, claim, carrier, `money`, CompanyCam link) + `GET /projects/:id/notes` |
| `hub sync` proposal | `PATCH /projects/:id {proposalAmount}`: Homebase stamps the submitted date as the day of the write |
| `hub sync` stage | `PATCH /projects/:id/stage {stage, fromStage}`: refused (409) if the job moved since it was read |
| `hub log <job#> call …` | `POST /projects/:id/activity {kind: "call", direction, who, subject, details}` |
| `hub log <job#> note …` | `POST /projects/:id/notes {body, prefix: "🧮 Estimating hub"}` |
| email logging | BCC `office+<job#>@forefrontteam.com` (unchanged). Filed emails show at `GET /projects/:id/emails` |
| (available) upload estimate PDFs | `POST /projects/:id/documents` (multipart, `kind=estimate`) via `ApiHomebase.uploadDocument` |

## Requests for Homebase (small)

1. **Backdating the proposal date.** `proposalAmount` stamps today's date and there's no way to send the date.
   When a proposal goes out late in the day and is logged the next morning, the Day 2/5/10/21 follow-ups start a
   day late. Could `PATCH /projects/:id` take an optional `proposalSubmittedOn` alongside `proposalAmount`?
2. **`money.proposalSubmittedOn` reads null** on job 3226, which has a proposal amount (2026-11-05). Is the date
   stored somewhere else, or is that read not wired yet?
3. **Adjuster email on the job.** The hub reads adjusters from `brief.adjuster1/2`. Most jobs have none, so the
   adjuster's address lives only in Gmail. That's fine for now; the hub can also set it (`POST /contacts` +
   `PATCH /projects/:id {adjuster1}`) once we agree it should.
