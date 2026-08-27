# HANDOFF — current state and next task

Last updated: 2026-08-26 (Increment 3 complete; pushed to
https://github.com/FramehouseStudios/PitlinkServices)

## Phase status

**Phase 0 — Foundation.** Exit criterion: end-to-end request created, matched
(mock or live), tracked, and closed with stored evidence events producing a
reproducible timeline.

## Delivery Plan progress (Blueprint §12)

| # | Increment | Status |
|---|-----------|--------|
| 1 | Project skeleton + config + evidence table | DONE |
| 2 | Auth + member/provider principals | DONE |
| 3 | Request create + append-only events | **DONE** (this hand-off) |
| 4 | Basic AI agent tool-calling loop | **NEXT** |
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

### Increment 3 decisions (requests + API)

- Lifecycle state machine lives in ONE place: `TRANSITIONS` in
  `src/requests/types.ts`, with per-transition actor-population policy in
  `TRANSITION_ACTORS`. `triaged → resolved` is the deliberate remote/software
  close (doctrine: software before metal). Denied transitions (illegal jump,
  wrong population, non-owner member) emit `request.transition_denied`
  evidence BEFORE throwing — hard rule 10 is now request-scoped.
- Evidence before side effects, literally: `RequestService.create/transition`
  append to the spine first, then write the `requests` projection row. The
  projection self-heals from the creation event on idempotent replay (tested
  by simulating a crash between the two writes).
- Service catalog is config: `SERVICE_TYPES` env, defaulting to the canonical
  categories (`DEFAULT_SERVICE_TYPES` in `src/common/config.ts`). Not an
  enum, not a DB constraint — packaging per type is an open RFI.
- HTTP surface is owned code over `node:http` (`src/api/server.ts`) — no
  framework until a measured trigger. Member-only endpoints: signup, login,
  create request (Idempotency-Key header required), get, timeline, cancel.
  Cross-member access returns 404 (existence not leaked). Login failure is
  identical for unknown email and wrong password. `npm run dev` serves it;
  smoke-tested live against Postgres on 2026-08-26.
- brain.md + agent/ configuration set added at repo root (session entry:
  CLAUDE.md → brain.md → agent/* → this file). Pitlink-only content;
  residue-scanned.

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
- Request-scoped denials now land on the evidence spine
  (`request.transition_denied`). HTTP-gate token denials (no request id yet)
  still audit in-memory only; persist them when an ops surface needs them.
- The API smoke test is manual (`npm run dev` + curl); the automated API
  tests use in-memory stores. Wiring an automated end-to-end HTTP+Postgres
  test is cheap if drift appears.
- npm blocked esbuild's postinstall script during install
  (`npm approve-scripts` policy on this machine); vitest/tsx still work. If a
  future toolchain step fails on a missing esbuild binary, approve the script.
- No HTTP server / entrypoint yet — deliberately deferred until increments 2–3
  give it something real to serve.

## Next active task (Increment 4)

Basic AI agent tool-calling loop: an owned LLM adapter interface (Contract
Gate — no OpenAI SDK in domain code; LLM routing/model names are UNKNOWN_RFI,
so the adapter is configured, never hard-coded), a conversational triage loop
in `src/agents/` whose tools call `RequestService` (create on behalf of the
authenticated member, transition to `triaged`, attempt the remote-resolution
path first), and evidence events for agent actions (actor_type `system`).
A deterministic/mock LLM adapter makes the loop fully testable without any
vendor key. After this, increment 5 (mock matching) completes the Phase 0
exit criterion path.
