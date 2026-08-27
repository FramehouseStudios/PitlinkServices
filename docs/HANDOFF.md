# HANDOFF — current state and next task

Last updated: 2026-08-26 (Increment 1 complete)

## Phase status

**Phase 0 — Foundation.** Exit criterion: end-to-end request created, matched
(mock or live), tracked, and closed with stored evidence events producing a
reproducible timeline.

## Delivery Plan progress (Blueprint §12)

| # | Increment | Status |
|---|-----------|--------|
| 1 | Project skeleton + config + evidence table | **DONE** (this hand-off) |
| 2 | Auth + member/provider principals | **NEXT** |
| 3 | Request create + append-only events | pending |
| 4 | Basic AI agent tool-calling loop | pending |
| 5 | Matching interface (mock providers) | pending |
| 6 | Redis presence + WS status | pending |
| 7 | Stripe membership/incident skeleton | pending |
| 8–12 | Live provider adapter, tracking/ETA, reconciliation, observability, first paid path | pending |

## Decisions made (do not re-litigate)

- **[DECIDED — founder, 2026-08-26]** Runtime: Node.js + TypeScript (closes the
  Blueprint §15 "Node vs Python" RFI).
- **[RECOMMENDATION, adopted]** Tooling: npm, vitest, tsx, plain `pg` (no ORM),
  forward-only SQL migrations via `scripts/migrate.ts`. All reversible.
- Evidence schema: `evidence_events(request_id UUID, event_type, payload JSONB,
  actor_type CHECK member|provider|ops|system, actor_id,
  calculation_rules_version, idempotency_key UNIQUE, occurred_at, recorded_at)`.
  Append-only is enforced by a DB trigger (migrations/001), by the
  `EvidenceStore` interface exposing only `append`/`timeline`, and by tests.
- Idempotency semantics: replaying an `idempotencyKey` returns the ORIGINAL
  stored event (payload differences on replay are ignored, not merged).
- Stores return defensive copies; mutating a returned event never reaches the
  spine (this was a real bug caught by test, fixed in `inMemoryStore.ts`).

## Open RFIs (surface, don't invent)

- Pricing/packaging, provider payout model, Phase 1 density targets,
  voice telephony provider, LLM routing/model names, verification vendor.

## Known gaps / residual risks

- `PostgresEvidenceStore` and the migration are written but not exercised by an
  automated test (no Postgres in the test environment). Before relying on it,
  run `docker compose up -d && npm run migrate` and add an integration test
  (suggest: gated behind `DATABASE_URL` presence). The DB append-only trigger
  is therefore verified by inspection only.
- npm blocked esbuild's postinstall script during install
  (`npm approve-scripts` policy on this machine); vitest/tsx still work. If a
  future toolchain step fails on a missing esbuild binary, approve the script.
- No HTTP server / entrypoint yet — deliberately deferred until increments 2–3
  give it something real to serve.

## Next active task (Increment 2)

Auth + member/provider principals: JWT issuance/verification using
`JWT_SECRET`/`JWT_EXPIRY` from config, structurally separate principal types
(member vs provider vs ops — separate tables or a discriminated principal with
no shared session surface), and middleware that resolves actor identity so
increment 3's request events can carry a real `actorType`/`actorId`. Every
privileged write must resolve actor + role; denials audited (evidence events).
