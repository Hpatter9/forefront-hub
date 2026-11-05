# Homebase API: request for the Forefront hub

**From:** Hunter Patterson (estimating) · **For:** Homebase · **Status:** proposal

Until this exists, the hub logs into Homebase with my account in a browser and clicks through the same screens I
do. That works, but it breaks whenever a page changes. A small JSON API, the endpoints below, would let the hub
read my jobs and record proposals reliably. Everything here is something I already do by hand in Homebase today.

## Basics

- Base URL: `https://homebase.forefrontteam.com/api/v1`
- Auth: a personal API token per user, sent as `Authorization: Bearer <token>`. Every call acts as that user, with
  that user's permissions, and shows as that user in the Activity log. A token page under the user's settings
  (create / revoke) would be ideal.
- JSON in and out; dates as `YYYY-MM-DD`, times as ISO 8601 with offset; money as numbers (`3162.87`).
- Writes accept an `Idempotency-Key` header (a UUID). A retried request with the same key does nothing twice.
- Errors: `{ "error": "message" }` with 400 (bad input), 401, 403, 404, 409 (stage change not allowed), 422.

## Endpoints (in order of importance)

### 1. List my jobs
`GET /projects?department=reconstruction&assignee=me&status=open`

```json
{ "data": [ {
  "id": "0a1b2c3d-…", "job_number": 3226, "name": "Augustine", "url": "https://homebase…/projects/0a1b…",
  "address": "1071 Acapulco Ct, Colorado Springs, CO 80910",
  "stage": "Proposal Submitted", "stage_entered_at": "2026-11-05T17:02:00-07:00",
  "last_activity_at": "2026-11-05T17:50:01-07:00",
  "proposal_amount": 3162.87, "proposal_submitted_at": "2026-11-05", "contract_amount": null
} ] }
```

### 2. One job
`GET /projects/{id}` and `GET /projects/by-number/{job_number}` return everything in the list, plus:

```json
{
  "intake_email": "office+3226@forefrontteam.com",
  "carrier": "Farmers", "claim_number": "5045106171-1", "date_of_loss": "2026-09-28",
  "contacts": [
    { "role": "customer", "name": "Jeremy Augustine", "email": "…", "phone": "…" },
    { "role": "adjuster", "name": "Eileen Brandt", "email": "…", "phone": "719-418-9596" }
  ],
  "notes": [ { "id": "…", "kind": "note", "body": "…", "author": "Hunter Patterson", "occurred_at": "…" } ],
  "documents": [ { "id": "…", "label": "Reconstruction Estimate", "filename": "…", "url": "…", "uploaded_at": "…" } ],
  "external_links": { "companycam_project_id": "117697136", "docusketch_project_id": "5625744" }
}
```

### 3. Record a proposal (the most important write)
`PATCH /projects/{id}/financials`

```json
{ "proposal_amount": 3162.87, "proposal_submitted_at": "2026-11-05" }
```
- `proposal_amount` and `proposal_submitted_at` are set together. Setting the date (re)starts the Day 2/5/10/21
  follow-up sequence exactly as it does in the UI today.
- `contract_amount` can be sent on its own when a job is won.
- Returns the updated financials.

### 4. Change stage
`POST /projects/{id}/stage` with `{ "stage": "Proposal Submitted", "note": "optional" }`
- Same rules and side effects as the stage control in the UI. Returns 409 with a reason if the move isn't allowed.
- `GET /stages` lists the stage names in order.

### 5. Add a note or a call log
`POST /projects/{id}/notes` with `{ "kind": "note" | "call", "body": "…", "occurred_at": "2026-11-05T10:30:00-07:00" }`

### 6. Upload a document (nice to have)
`POST /projects/{id}/documents` (multipart: `file`, `label`), so the final estimate PDFs live on the job.

### 7. External links (nice to have)
`PATCH /projects/{id}/external_links` with `{ "companycam_project_id": "…", "docusketch_project_id": "…" }`

## Optional later
- Webhooks (`stage.changed`, `financials.changed`, `note.created`) posting the job JSON to a URL I register, so
  the hub hears about changes without polling.

## What the hub does today without it

| Need | Today (browser) | With the API |
|---|---|---|
| My open jobs | read the /departments/reconstruction page | endpoint 1 |
| Job details, contacts | read the job page | endpoint 2 |
| Proposal amount + date | fill the financials form | endpoint 3 |
| Stage | the stage control | endpoint 4 |
| Notes / calls | the notes box | endpoint 5 |
| Email logging | BCC office+<job#>@forefrontteam.com | unchanged (works well) |
