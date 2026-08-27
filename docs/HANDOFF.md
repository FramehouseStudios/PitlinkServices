# HANDOFF — current state and next task

Last updated: 2026-08-26 (Increment 11 + provider API surface complete;
pushed to https://github.com/FramehouseStudios/PitlinkServices)

## Phase status

**Phase 0 — Foundation.** Exit criterion: end-to-end request created, matched
(mock or live), tracked, and closed with stored evidence events producing a
reproducible timeline.

## Delivery Plan progress (Blueprint §12)

| # | Increment | Status |
|---|-----------|--------|
| 1 | Project skeleton + config + evidence table | DONE |
| 2 | Auth + member/provider principals | DONE |
| 3 | Request create + append-only events | DONE |
| 4 | Basic AI agent tool-calling loop | DONE |
| 5 | Matching interface (mock providers) | DONE |
| 6 | Redis presence + WS status | DONE |
| 7 | Stripe membership/incident skeleton | **DONE** (this hand-off) |
| 8 | Live provider adapter + acceptance | pending (Phase 1 gated — needs real providers) |
| 9 | Tracking + ETA events | **DONE** (this hand-off) |
| 10 | Reconciliation + metric calculation rules | **DONE** (this hand-off) |
| 11 | Observability baseline | **DONE** (this hand-off) |
| — | Provider API surface (beyond plan) | **DONE** (this hand-off) |
| 12 | First end-to-end paid path in DEFAULT_CITY | pending (needs founder: pricing + Stripe keys) |

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

### Increment 4 decisions (AI agent loop)

- `LlmAdapter` (`src/agents/llm.ts`) is the owned contract; NO vendor
  implementation exists yet because LLM routing/model names are UNKNOWN_RFI.
  `ScriptedLlmAdapter` (steps may be functions of the transcript) makes the
  loop fully testable offline. When the founder decides routing, write the
  vendor adapter behind this interface — domain code must not change.
- `AgentToolbox` is bound to one member session; every request-touching tool
  proves ownership first ("not found" for foreign requests — tested).
  Tool effects derive idempotency keys from `conversationId + toolCallId`, so
  a retried tool call cannot duplicate a request.
- `TriageAgent` loop: max 8 iterations, then a safe operator-handoff message
  (`exhausted: true`). Tool failures are returned to the model as results,
  never thrown. Actor attribution: creates/cancels as the member,
  triage/remote-resolve as `system` (id `triage-agent`).
- **Defect found & fixed:** transition idempotency keys were globally
  namespaced; the same client key on two different requests collided into a
  silent no-op. Keys are now scoped
  `request.transition:<requestId>:<to>:<key>` — regression-tested. (Found
  because the integration test's static keys replayed across runs against the
  persistent DB — replay semantics were working exactly as designed.)
- The agent loop is domain-level only; no HTTP conversation endpoint yet —
  that lands with (or after) the real LLM adapter decision, since a scripted
  conversation over HTTP proves nothing new.

### Increment 5 decisions (matching)

- `MatchingEngine` (`src/matching/engine.ts`): triaged request → nearest
  capable available provider (haversine, `src/common/geo.ts`), with the
  offer/accept pair recorded as SEPARATE evidence events
  (`provider.offered` system / `provider.accepted` provider) even though the
  Phase 0 mock auto-accepts — Phase 1's real accept/decline latency drops in
  behind the same events with no schema change.
- Match failure is metric-affecting (density risk is the #1 business risk),
  so `request.match_failed` goes on the spine with reason + city; the request
  stays `triaged` and a new attempt can succeed after supply recovers
  (tested). `ENABLE_PROVIDER_MARKETPLACE=false` refuses cleanly with NO
  evidence (config state, not a runtime event).
- `MockProviderDirectory` seed data is explicitly MOCK — no commercial
  meaning, never customer-facing.
- **Phase 0 exit criterion is now an executable test**
  (`src/phase0.exit.test.ts`): the full journey driven only through public
  domain surfaces, timeline reproduced from the spine, and request→arrival
  (18 min in the fixture) derived from stored events alone. This is the
  falsifiable phase gate — run it any time someone asks "is Phase 0 real?"
- Founder mandates recorded in `agent/USER.md`: intelligence-business-
  developer directive + CEO-level autonomy (stop only for binding/capital/
  legal matters).

### Increment 6 decisions (realtime)

- `ProviderPresence` (`src/realtime/presence.ts`): heartbeat + TTL is THE
  availability model — a silent provider ages out of supply automatically
  (no stale flags). Redis impl uses SET EX + a per-city SET index with
  opportunistic stale cleanup; in-memory impl mirrors semantics via an
  injectable clock. `PresenceProviderDirectory` slots into the SAME
  `ProviderDirectory` interface — the matching engine needed zero changes to
  go from mock to live supply (tested: offline → match_failed, heartbeat →
  matched).
- Realtime push: `RequestEventBus` is an in-process pub/sub — deliberately
  NOT a broker (Blueprint §13). `RequestService` and `MatchingEngine` accept
  an optional `onEvent` hook fired only for NEW spine events (replays and
  the spine itself stay authoritative). WS surface (`src/realtime/ws.ts`,
  path `/ws?token=&requestId=`): auth + ownership checked before any
  subscription; close 4401 unauthorized / 4404 not-found (existence not
  leaked); snapshot (request + full timeline) then live events.
- `redis` and `ws` added as runtime deps — infrastructure drivers, not
  vendor SDKs; Contract Gate intact. vitest upgraded 2→3: npm audit now
  ZERO vulnerabilities (previous 5 were all dev-chain esbuild/vite).
- Entrypoint (`src/index.ts`) now boots API + WS + Redis presence together;
  boot-verified against the live stack.

### Increment 7 decisions (payments)

- `PaymentsAdapter` (`src/payments/adapter.ts`) is the owned rail contract;
  `FakePaymentsAdapter` (deterministic, idempotent, failure/crash injection)
  is the only implementation until Stripe keys + commercial terms exist.
  NO amount constant exists anywhere — every amountCents is a parameter
  (pricing/packaging is founder RFI #1).
- `PaymentsService`: `payment.intent_created` on the spine BEFORE the rail is
  touched; `payment.succeeded`/`payment.failed` as the outcome record.
  Crash-recovery tested: crash between intent and outcome → retry with the
  same chargeKey completes with exactly one intent, one outcome, one charge
  (prior-outcome scan by chargeKey).
- `WebhookIngestor` (`src/payments/webhook.ts`): hard rule 4 in full —
  idempotency by vendor delivery id, dead-letter for malformed/unknown/
  handler-failure, replay that consumes the letter. Handler failures do NOT
  mark processed (retryable). The future Stripe adapter normalizes vendor
  payloads into the owned envelope before ingestion.
- Intelligence memo `docs/intel/roadside-app-review.md`: reviewed the
  founder-supplied FramehouseStudios/roadside-app fork (cloned at
  `~/roadside-app`). Verdict: mine, don't merge. Actionable backlog captured:
  vehicles bounded context (triage needs it), post-resolution feedback as
  spine events, bidding-vs-dispatch documented inside the pricing RFI.
  Rejected: shared user table, card storage in our DB, session auth, its
  deprecated client stack.

### Increment 9 decisions (tracking + ETA)

- `TrackingService` (`src/realtime/tracking.ts`): pings accepted only from
  the ASSIGNED provider (assignment derived from the spine's
  `provider.accepted` — evidence is the source of truth, no new column),
  only while `en_route`, throttled (default min 15s between recorded pings;
  denied/throttled pings leave nothing on the spine).
- ETA is an ESTIMATE with its basis stored IN the event payload
  (`etaBasis: { method: "straight_line", assumedSpeedKmh }`) so every
  historical ETA is recomputable. A maps/routing adapter replaces the
  heuristic behind an owned interface when routing is worth paying for.

### Increment 10 decisions (metrics + reconciliation)

- `src/common/metrics/calculations.ts`: THE versioned metric rules
  (`METRIC_RULES_VERSION`), pure functions over `EvidenceEvent[]`:
  request→arrival / →resolution / →match, remote-resolution rate
  (unresolved requests are excluded, not counted as failures), match-failure
  count, paid cents by currency (succeeded only), `fleetMetrics()` medians.
  Any published number must come from these functions over the spine.
- `src/common/metrics/reconcile.ts`: `deriveStatus` (last lifecycle event
  wins) + `reconcileRequest` reporting `status_drift` / `missing_projection`
  / `no_lifecycle_events`. Discrepancies are REPORTED, never auto-repaired.
  No scheduled job yet — single process, run on demand; a cron joins with
  the ops surface.
- The Phase 0 exit test now also proves "tracked" (a real location ping in
  the timeline) and derives its metrics through the versioned rules +
  reconciliation — the exit criterion and the metrics story are one test.

### Increment 11 + provider surface decisions

- **Security fix (real):** transition authorization previously checked
  population only — ANY provider principal could push en_route on ANY
  matched request. `RequestService.transition` now enforces assignment from
  the spine's `provider.accepted` (single source: `assignedProvider()`,
  shared with tracking), denial reason `not_assigned_provider`, audited.
- **Second fix from the adversarial pass:** identity checks (population,
  ownership, assignment) now run BEFORE state-machine checks in both
  `transition` and `providerPing` — an actor with no right to a request
  learns nothing about its state from the error; the API masks
  `not_assigned_provider` as 404.
- Logger (`src/common/logger.ts`): owned JSON-lines logger; keys matching
  token/password/secret/authorization/apiKey/email/card/ssn are REDACTED at
  write time, nested objects included — hard rule 9 enforced structurally.
  API access logs carry method/path/status/ms only.
- `GET /health`: dependency probes injected via `healthChecks`
  (Postgres SELECT 1, Redis candidates read in prod wiring); 200/503.
- Provider HTTP surface: `/providers/signup|login` (shared handler,
  structurally separate stores), `/providers/heartbeat` (TTL default 60s
  ESTIMATE), `POST /requests/:id/en_route|on_scene|resolved` (Idempotency-Key
  required), `POST /requests/:id/ping`. Full provider journey now drivable
  over HTTP — tested end to end incl. member timeline visibility.
- OTel/Sentry remain env placeholders — wire exporters when a deploy target
  exists.

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

## Next active task

The Delivery Plan's ungated increments are COMPLETE (1–7, 9–11 + provider
surface). Remaining gates: 8 (live providers — Phase 1 physical work),
12 (first paid path — founder pricing + Stripe keys [ABSOLUTELY-HUMAN]).

Highest-leverage ungated backlog, in order:
1. Vehicles bounded context (intel memo): member vehicles, optional
   vehicleId on request create — triage quality depends on it.
2. Post-resolution feedback (`request.feedback` evidence; member-only,
   own-request-only) — retention signal + provider quality from the spine.
3. Ops read surface: fleet metrics endpoint (ops principal) serving
   `fleetMetrics()` over recent requests + reconciliation sweep.
4. Member web surface (web-first per canonical docs) — the "Dorsey-grade"
   minimal UI: one screen to request help, one live tracking view.
