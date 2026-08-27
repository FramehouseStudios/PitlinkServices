# HANDOFF — current state and next task

Last updated: 2026-08-26 (Increment 2 complete; pushed to
https://github.com/FramehouseStudios/PitlinkServices)

## Phase status

**Phase 0 — Foundation.** Exit criterion: end-to-end request created, matched
(mock or live), tracked, and closed with stored evidence events producing a
reproducible timeline.

## Delivery Plan progress (Blueprint §12)

| # | Increment | Status |
|---|-----------|--------|
| 1 | Project skeleton + config + evidence table | DONE |
| 2 | Auth + member/provider principals | **DONE** (this hand-off) |
| 3 | Request create + append-only events | **NEXT** |
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

### Increment 2 decisions (auth)

- **[RECOMMENDATION, adopted]** Owned HS256 JWT via `node:crypto`
  (`src/common/auth/token.ts`) — zero dependencies; the verifier never reads
  the header's `alg`, so algorithm confusion is structurally impossible
  (regression-tested). Passwords: scrypt with parameters stored in the hash
  string so cost can be raised without invalidating credentials.
- Populations (member / provider / ops) live in separate tables
  (migrations/002) and separate `PrincipalStore` instances; the same email may
  exist in each population but never twice in one. Tokens carry `ptype`;
  `requirePrincipal()` is the single choke point — cross-population access
  throws and every denial goes to an `AuthAuditSink` (hard rule 10). The
  in-memory sink is a stopgap: wire denials into evidence events once
  privileged writes are request-scoped (increment 3).
- Provider `verification_status` (pending/verified/rejected) is schema-only;
  verification vendor remains UNKNOWN_RFI.

## Open RFIs (surface, don't invent)

- Pricing/packaging, provider payout model, Phase 1 density targets,
  voice telephony provider, LLM routing/model names, verification vendor.

## Known gaps / residual risks

- ~~PostgresEvidenceStore unverified~~ CLOSED: `docker compose up -d` +
  `npm run migrate` ran clean (001, 002 applied), and
  `src/common/integration.pg.test.ts` now exercises the real stores and proves
  the DB append-only trigger live. It auto-skips when `DATABASE_URL` is unset:
  `DATABASE_URL=postgres://pitlink:pitlink@localhost:5432/pitlink npx vitest run`.
- `JWT_SECRET` strength is not enforced (the `.env.example` placeholder
  "change-me" would be accepted). Add a production-startup strength check when
  an environment concept exists.
- Auth denials are audited in-memory only until increment 3 wires them to a
  persistent sink.
- npm blocked esbuild's postinstall script during install
  (`npm approve-scripts` policy on this machine); vitest/tsx still work. If a
  future toolchain step fails on a missing esbuild binary, approve the script.
- No HTTP server / entrypoint yet — deliberately deferred until increments 2–3
  give it something real to serve.

## Next active task (Increment 3)

Request create + append-only events: the Request bounded context (entity +
lifecycle states from the canonical journey: created → triaged → matched →
en_route → on_scene → resolved/closed, plus failure states), an HTTP surface
(REST) that authenticates via `requirePrincipal("member")` and emits an
evidence event BEFORE any side effect, and idempotency keys on the create
path. Wire `AuthAuditSink` denials into evidence events where a request id
exists. Service types (jump, tire, lockout, fuel/EV, tow) should be config or
data, not enum-hard-coded, if pricing/packaging may vary per type
(UNKNOWN_RFI). This increment is the heart of the Phase 0 exit criterion —
after it, only mock matching (5) and a close path stand between us and a
reproducible end-to-end timeline.
