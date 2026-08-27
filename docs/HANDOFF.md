# HANDOFF — current state and next task

Last updated: 2026-08-26 (SERVICE RELIABILITY LAYER — no-show recovery,
match retry, service-health alerts; verified live in a browser; pushed to
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
| 3 | Request create + append-only events | DONE |
| 4 | Basic AI agent tool-calling loop | DONE |
| 5 | Matching interface (mock providers) | DONE |
| 6 | Redis presence + WS status | DONE |
| 7 | Stripe membership/incident skeleton | **DONE** (this hand-off) |
| 8 | Live provider adapter + acceptance | pending (Phase 1 gated — needs real providers) |
| 9 | Tracking + ETA events | **DONE** (this hand-off) |
| 10 | Reconciliation + metric calculation rules | **DONE** (this hand-off) |
| 11 | Observability baseline | **DONE** (this hand-off) |
| — | Provider API surface (beyond plan) | DONE |
| — | Vehicles bounded context (backlog 1) | **DONE** (this hand-off) |
| — | Post-resolution feedback (backlog 2) | DONE |
| — | Ops read surface (backlog 3) | DONE |
| — | Member web surface (backlog 4) | DONE |
| — | **Service reliability layer** (Blueprint §9 controls) | **DONE** (this hand-off) |
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

### Vehicles + feedback decisions (backlog 1+2)

- Vehicles (`src/members/vehicles.ts`, migration 004): make/model/year/
  powertrain (ice|ev|hybrid|unknown) — deliberately NO plate or VIN (PII
  minimization) until a feature needs them. Ownership structural: every read
  requires memberId. Attaching a vehicle to a request stores `vehicleId` on
  the projection AND a snapshot (make/model/powertrain) inside the
  `request.created` payload, so triage context stays reproducible even if
  the vehicle record later changes. API: POST/GET /vehicles; `vehicleId`
  optional on request create (404 if not owned).
- Feedback: `RequestService.feedback` — owning member only (404 mask for
  everyone else, identity-before-state), only after resolved/closed, rating
  integer 1–5 + optional comment (≤2000 chars), ONE per request
  (`feedback:${requestId}` key; replay returns the original — a member
  cannot revise their rating; revision would need a compensating-event
  design, deliberately deferred). Payload carries assigned providerId when
  one exists, so provider quality aggregates from the spine.
- `providerRatings()` added to metric calculations (additive — no version
  bump): providerId → {count, avgRating}. Remote resolutions produce
  feedback without providerId and are excluded from provider quality.

### Ops read surface decisions (backlog 3)

- **[DECIDED, CEO autonomy]** Ops principals are NEVER self-signup. The only
  creation path is `scripts/seed-ops.ts` (env OPS_EMAIL/OPS_PASSWORD;
  idempotent — reruns leave an existing account untouched). The API exposes
  only `POST /ops/login`; `/ops/signup` deliberately does not exist (tested).
- `GET /ops/metrics?limit=` (ops token): `fleetMetrics()` + `providerRatings()`
  over the most recent requests' timelines (limit capped at 500). All numbers
  flow through the versioned rules — the endpoint computes nothing itself.
- `GET /ops/reconciliation?limit=`: reconcileRequest over recent requests;
  returns checked/consistent counts + discrepancy details. Tested: a
  corrupted projection surfaces as `status_drift` with both statuses named.
- Live-verified against the real stack: seed → login → metrics (18 requests
  in the local DB, all reconciling consistent) → health 200.
- `RequestStore.listRecent(limit)` added (newest first) for ops reads.

### Member web surface decisions (backlog 4)

- One static file (`public/index.html`), zero frameworks, zero build step,
  served by the monolith at GET /. Inline CSS/JS, system font, black on
  white, one accent color. Three panels: auth (login/signup), request
  (service select from GET /catalog + location with geolocation button),
  live tracking (WS snapshot + live events, human-readable labels,
  ETA line from location_update pushes, cancel until terminal).
- `GET /catalog` (public, non-sensitive): serviceTypes + defaultCity, so
  the client renders the form without hardcoding the catalog.
- **Phase 0 orchestration in the entrypoint** (`src/index.ts`): on
  `request.created`, the server auto-triages (system `auto-triage`) and
  attempts a match in-process. This is deliberate: WS push is in-process by
  design, and the conversational agent takes over triage once LLM routing
  is decided — the auto-flow is its stand-in, not a replacement.
- Verified LIVE in a real browser: signup → guard against missing location
  → request created → timeline streamed created/triaged/offered/accepted/
  matched instantly → provider (via HTTP API) drove en_route/ping (ETA
  pushed to the page)/on_scene/resolved — all rendered in real time.
  ~18s request→resolution in the demo run.
- Client token in localStorage [ASSUMPTION — acceptable Phase 0; revisit
  with a security pass before real members].
- Repo path contains a space: use `fileURLToPath(new URL(...))`, never
  `new URL(...).pathname` (bit us — %20).

### Service reliability layer (CEO decision, 2026-08-26)

**Why this over anything else:** world-class roadside service is not won on
the happy path — it is won when nobody comes and nobody tells you. Before
this, a no-show provider stranded a member on a "Matched" screen forever;
one failed match ended the search permanently. Blueprint §9 names these as
required controls. All ungated. This is the difference between a demo and a
service people trust with their safety.

- `ReliabilityService.sweep()` (`src/reliability/service.ts`) runs every
  RELIABILITY_SWEEP_SECONDS (default 30, in-process — a worker split is a
  measured trigger, not a day-one need) over triaged/matched/en_route
  requests:
  - **Nobody found:** retries matching once per `rematchIntervalSeconds`
    bucket (idempotent by bucket, so sweep frequency ≠ retry frequency);
    after `unmatchedEscalationSeconds` emits `request.escalated` ONCE.
  - **Provider never starts** (matched → no en_route within
    `acceptToEnRouteSeconds`) **or never arrives** (en_route beyond
    `enRouteToArrivalSeconds`): emits `provider.no_show` +
    `provider.unassigned`, returns the request to `triaged`, and the next
    sweep rematches it.
- **Assignment semantics changed:** `assignedProvider()` now honors
  `provider.unassigned` (a later unassign clears an earlier accept), and the
  matching engine EXCLUDES every previously offered/accepted provider on
  that request — a member never waits on the same failed truck twice.
- State machine gained `matched → triaged` and `en_route → triaged` purely
  as recovery edges.
- All policy thresholds are env-tunable (RELIABILITY_*) — ESTIMATEs, not
  hard-coded commercial decisions.
- `serviceHealth()` (`src/reliability/alerts.ts`): median arrival, match-
  failure rate, no-show rate, escalation count → alerts with observed vs
  threshold and severity. **Silent below `minSample` (5)** — alerting on
  three data points is theater. Thresholds are ESTIMATEs pending the density
  RFI. Served at `GET /ops/health`; `POST /ops/sweep` forces a pass.
- Member UI tells the truth immediately: "Your provider fell through —
  finding another", "A Pitlink operator is now on this".
- **Verified live in a browser:** member requested a tow → matched to the
  nearest provider → that provider never moved → the page showed the
  fall-through message and re-matched to a DIFFERENT provider automatically,
  no member action; when that one also stalled it recovered again and, with
  supply exhausted, recorded `match_failed`. Ops health then reported a
  critical no-show-rate alert computed from those stored events.

## THE UNGATED BUILD IS COMPLETE

Everything buildable without founder decisions now exists and is verified:
evidence spine, isolated principals ×3, request lifecycle, AI agent loop
(scripted adapter), matching, presence, WS tracking, payments skeleton,
tracking+ETA, versioned metrics, reconciliation, observability, provider
API, vehicles, feedback, ops reads, member web app. What remains needs the
founder: pricing + Stripe keys (increment 12), live providers in
DEFAULT_CITY (increment 8), LLM routing (real agent), voice provider,
verification vendor, density targets.

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

Founder-gated work (see above), or these ungated service-quality items in
order:
1. Proactive member communication: push the ETA and recovery events into a
   channel the member sees when the page is closed (needs the voice/SMS
   provider RFI for SMS; in-page is done).
2. Provider quality gating: exclude providers whose no-show rate or rating
   crosses a threshold from matching (uses providerRatings + no_show
   events already on the spine).
3. Deploy target + JWT secret strength check + provider web surface.
