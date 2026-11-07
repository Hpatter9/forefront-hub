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
