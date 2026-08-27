# brain.md — Pitlink Operating Brain

> **Read this file first, every session, before doing anything else.**
> It compresses the three canonical documents (Founder Product Brief, Platform
> Proposal, Technical Architecture Blueprint) into an executable operating file
> and holds the current state. **The canonical documents win every conflict**;
> this file wins over everything else in the repo until a disagreement is
> resolved and recorded in the Change Log.

- **Version:** 0.1.0
- **Prepared:** 2026-08-26
- **Repository:** `FramehouseStudios/PitlinkServices`
- **Status:** Phase 0 — Foundation. Increments 1–4 complete, 5 next.

---

## 0. How to use this file

| If you are… | Read |
|---|---|
| Starting a session cold | this file, then `agent/README.md`, then `docs/HANDOFF.md` |
| About to write code | §3 Loop Protocol → §5 Architecture Doctrine → §8 Completion Standard |
| About to state a number, price, or commercial term | §4 Evidence Discipline + §7 Open RFIs |
| Stuck or looping | §3.3 Stop conditions |
| Finishing material work | §8 report format + update `docs/HANDOFF.md` + append §9 Change Log |

---

## 1. North Star

> **Pitlink is an AI-native mobility assistance platform that turns being
> stranded into a solved problem** — fast, reliable, intelligent roadside and
> mobility help through conversational agents, real-time matching, and a
> provider marketplace.

**Primary metric:** median request → arrival/resolution time, fully
instrumented and reproducible from stored events. The goal is to make the
legacy 45–90 minute experience feel archaic, with unit economics that scale
through density.

**Anti-definition:** not a call-center roadside membership company, not a
towing broker that owns trucks, not an insurance/claims administrator, not an
OEM telematics platform in early phases. We never claim to eliminate human
providers or guarantee sub-30-minute arrival everywhere on day one.

### The one-sentence test
If a proposed piece of work does not advance the **next phase exit criterion**
(currently: end-to-end request created → matched → tracked → closed with a
reproducible evidence timeline), it is not current work. Log it and move on.

---

## 2. Scope Boundaries

| Layer | Owner | Notes |
|---|---|---|
| Conversational AI agent (voice + chat) | **Us** | Tool-calling orchestration over the request loop |
| Matching & dispatch engine | **Us** | Mock first, live in Phase 1 |
| Live tracking, presence, dynamic ETA | **Us** | Redis + WebSockets |
| Provider marketplace coordination | **Us** | Verification vendor is an open RFI |
| Membership, payments, billing | **Us via Stripe adapter** | Stripe moves the money |
| Evidence spine, metrics, observability | **Us** | Product feature, not ops afterthought |
| On-scene physical work (jump, tire, lockout, fuel/EV, tow) | **Providers** | Background-checked marketplace supply |
| Payment rails | **Stripe** | Behind an owned adapter |
| Maps/routing | **Mapbox/Google** | Behind an owned adapter |
| Voice telephony fallback | **Vendor (RFI)** | Twilio mentioned, not decided |

**Never claim (early phases):** guaranteed arrival times in low-density areas,
ownership/employment of providers, insurance coverage or liability for
provider work product, OEM-level predictive diagnostics, "we fix every vehicle
remotely." Safety and liability non-claims are product features.

---

## 3. The Loop Protocol

All material work runs: **PLAN → DO → VERIFY → ADVERSARIAL PASS → DECIDE.**

1. **PLAN** — the single smallest change that advances the active phase exit
   criterion; name the Delivery Plan increment (Blueprint §12).
2. **DO** — make only that change. Surgical: every changed line traces to the task.
3. **VERIFY** — run the relevant tests plus at least one failure-mode test on
   material paths. Score each criterion 1–10; name the weakest point honestly.
4. **ADVERSARIAL PASS** — actively try to break tenant isolation, evidence
   integrity, idempotency, the Contract Gate, or the phase goal. Document the
   attempt and the result. Successful attacks become regression tests.
5. **DECIDE** — proceed only when every criterion scores ≥ 8. Otherwise iterate
   on the weakest score first, or surface the blocker.

### 3.2 Code loop verifier
`npx tsc --noEmit` clean + `npm test` green (integration tests run when
`DATABASE_URL` is set) — a VERIFY that claims tests pass must have run them in
this session.

### 3.3 Stop conditions
Stop and ask the founder only when: proceeding under any assumption would make
the work useless or unsafe if wrong; the decision is commercially or legally
binding; or the question is one of the §7 founder-owned RFIs. Otherwise:
assume, **label it**, keep going, log it in HANDOFF. Also stop when two
consecutive iterations fail to raise the weakest score — the loop is broken;
change the approach, don't rerun it.

### 3.4 Anti-patterns
Motion loops (re-summarizing instead of changing something), soft passes
(scoring 8 because it "feels close"), scope drift, verifier theatre (criteria
that always pass), silent repair of contradictions, fabrication (filling an
RFI with a plausible value).

---

## 4. Evidence Discipline

Every material claim carries a label: `VERIFIED` (primary source / repo
artifact) · `DECIDED` (explicit founder decision, dated) · `ASSUMPTION` ·
`ESTIMATE` (show the formula) · `RECOMMENDATION` (state the reasoning) ·
`LEGAL_REVIEW` · `UNKNOWN_RFI`. Labels propagate into implementations.

**Hard rules:**
- Every material metric must be reproducible from stored source events +
  versioned calculation rules, or explicitly labeled otherwise. Numbers
  without that lineage are defects.
- Never hard-code open commercial decisions (§7). They live in env/config.
- Never present coverage, arrival times, or provider quality as guaranteed.
- Never compute customer-facing money or uptime only in the UI.
- Never promote an ASSUMPTION into irreversible schema, domain logic, or
  customer-facing language.

---

## 5. Architecture Doctrine

Modular monolith (Node.js + TypeScript, `[DECIDED 2026-08-26]`) + PostgreSQL
evidence spine + Redis presence/queues + owned vendor adapters + web/voice
surfaces. Full rationale in the Technical Architecture Blueprint.

1. **Evidence before side effects.** Every metric-affecting state change emits
   an append-only evidence event first. Corrections are compensating records.
   The DB enforces append-only with a trigger (migrations/001).
2. **Structural identity isolation.** Members, providers, and ops are separate
   populations: separate tables (migrations/002), separate stores, tokens
   carrying the population claim, one guard choke point (`requirePrincipal`).
   Cross-population access is structurally impossible, not a review catch.
   Denials are audited (hard rule 10).
3. **Contract Gate.** No domain code imports vendor SDKs (OpenAI, Mapbox,
   Stripe, Twilio). Every external system sits behind an owned adapter that
   normalizes errors, retries, and evidence emission. A PR violating this
   fails.
4. **Exactly-once ingestion.** Idempotency key + dead-letter + replay on every
   external ingestion path. Replaying an idempotency key returns the original
   stored event.
5. **Prefer software before metal.** The remote/software resolution path is
   tried first when physics allows; sending a truck is the fallback.
6. **Smallest system that proves the next gate.** Complexity requires a
   measured trigger (Blueprint §13): no microservices, Kafka, Kubernetes,
   native-app-first, warehouses, or predictive ML pipelines until the written
   trigger is hit. Refuse and cite the trigger.
7. **No secrets, payment data, or unnecessary PII in logs.** PII minimization
   in schemas (email only until a feature requires more).

---

## 6. Current State (sync with `docs/HANDOFF.md` — that file is the detail)

- Phase 0. Delivery Plan increments 1 (skeleton/config/evidence spine),
  2 (auth + isolated principals), 3 (request lifecycle + member REST API),
  and 4 (AI agent tool-calling loop behind an owned LlmAdapter; no vendor
  implementation until the routing RFI closes) are DONE, tested (45/45 incl.
  live Postgres integration), and pushed to `main`. `npm run dev` serves the
  member journey.
- Local stack: `docker compose up -d` (Postgres 16 + Redis 7), `npm run
  migrate`, `npm test`; integration tests auto-skip without `DATABASE_URL`.
- Decisions already made (do not re-litigate): runtime Node+TS `[DECIDED]`;
  owned HS256 JWT + scrypt `[RECOMMENDATION, adopted]`; idempotent replay
  returns the original event `[ASSUMPTION]`; `DEFAULT_CITY=los-angeles` and
  feature flags are env-only `[DECIDED]`.
- Known gaps: JWT secret strength unenforced; auth denials audited in-memory
  until request-scoped evidence exists.

---

## 7. Open Decisions — founder-owned, agents must surface, never invent

1. Membership pricing & packaging. `UNKNOWN_RFI`
2. Provider commission / payout model. `UNKNOWN_RFI`
3. Phase 1 density targets + provider acquisition plan for los-angeles. `UNKNOWN_RFI`
4. Voice telephony provider (Twilio optional, not decided). `UNKNOWN_RFI`
5. LLM routing and model names. `UNKNOWN_RFI`
6. Provider verification vendor. `UNKNOWN_RFI`

Closed: runtime (Node+TS, 2026-08-26).

---

## 8. Completion Standard (mandatory report on every material task)

**COMPLETED / FILES CHANGED / ROOT ISSUE ADDRESSED / VERIFICATION (tests +
failure-mode + score 1–10 + weakest point) / ASSUMPTIONS & OPEN DECISIONS /
EVIDENCE LABELS TOUCHED / NEXT ACTIVE TASK / CONTINUE STATUS / HANDOFF NOTES.**

Also update `docs/HANDOFF.md` and append a §9 entry.

---

## 9. Change Log

- **2026-08-26** — v0.1.0. Brain + `agent/` configuration set created for
  Pitlink, derived entirely from the three Pitlink canonical documents.
  Increments 1–2 complete and pushed; increment 3 (request lifecycle + REST
  surface) next.
- **2026-08-26** — Increment 3 shipped: request lifecycle state machine with
  per-transition actor policy and audited denials on the spine, evidence-first
  create/transition with self-healing projection, config-driven service
  catalog, owned node:http member API (signup/login/create/get/timeline/
  cancel, 404-masked cross-member access). 38/38 tests incl. live Postgres;
  live HTTP smoke passed. `brain.md` §6 and `docs/HANDOFF.md` updated.
- **2026-08-26** — Increment 4 shipped: owned `LlmAdapter` contract (Contract
  Gate held — zero vendor code; routing stays UNKNOWN_RFI), member-scoped
  `AgentToolbox` (foreign requests structurally invisible), `TriageAgent`
  loop with iteration ceiling and safe handoff, remote-resolution journey
  tested end to end on the spine. Fixed a real defect the process surfaced:
  transition idempotency keys are now scoped per request. 45/45 tests.
