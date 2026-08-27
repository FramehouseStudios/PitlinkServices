# MEMORY.md — Recall Cache

> Compressed memory so the agent never re-derives the shape of the business
> from scratch. **Derived from `brain.md` and the canonical documents; loses
> every conflict with them.** Updated only when `brain.md` changes.

- **Synced to:** brain.md v0.1.0, 2026-08-26

## 1. Mission (brain §1)

Pitlink turns being stranded into a solved problem: AI-native roadside and
mobility help via conversational agents, real-time matching, and a provider
marketplace. Primary metric: median request→arrival/resolution, reproducible
from stored events. Density in one beachhead city (los-angeles, from env) is
the physics; software-before-metal is the preference; capital efficiency over
narrative.

## 2. Current reality (brain §6, as of 2026-08-26)

- Phase 0 — Foundation. Increments 1–2 done, tested (23/23 incl. live
  Postgres), pushed to `FramehouseStudios/PitlinkServices` `main`.
- Built: modular monolith skeleton; strict env config; append-only
  `evidence_events` (DB trigger + append-only interface + idempotent replay);
  member/provider/ops principals in separate tables; owned HS256 JWT
  (alg-confusion structurally impossible); scrypt passwords; population guard
  with audited denials.
- Next: increment 3 — Request bounded context + REST surface; evidence event
  before every side effect; idempotent create.

## 3. Invariants — locked, do not reopen

1. **Evidence before side effects.** Append-only spine; corrections are
   compensating events; every metric traces to events + a versioned rule.
2. **Structural identity isolation.** Members / providers / ops: separate
   tables, separate stores, population claim in the token, one guard choke
   point. No shared sessions, ever.
3. **Contract Gate.** No vendor SDKs in domain code; owned adapters only.
4. **Exactly-once ingestion.** Idempotency key on every external path; replay
   returns the original event.
5. **Smallest system that proves the next gate.** Complexity needs the
   Blueprint §13 written trigger.

## 4. Decisions made (do not re-litigate)

- Runtime: Node.js + TypeScript. [DECIDED 2026-08-26]
- Tooling: npm, vitest, tsx, plain `pg` (no ORM), forward-only SQL
  migrations. [RECOMMENDATION, adopted]
- `DEFAULT_CITY=los-angeles`, `ENABLE_PROVIDER_MARKETPLACE=true`,
  `ENABLE_PREDICTIVE_ALERTS=false` — env-only, never code constants. [DECIDED]

## 5. Founder-owned RFIs — agent forbidden to invent (brain §7)

Pricing/packaging · provider payout model · Phase 1 density targets ·
voice telephony provider · LLM routing/models · verification vendor.

## 6. Not now (canonical docs, "explicitly out of early phases")

Native mobile apps as primary surface. Microservices. Kafka. Kubernetes.
Multi-region active-active. Predictive-ML pipeline. Asset ownership.
Call-center culture features. Full insurance/claims administration.

## 7. Memory discipline

- This file changes only when `brain.md` changes; bump "Synced to" in the
  same commit.
- Delivery detail lives in `docs/HANDOFF.md`, not here.
- If a claim here cannot be traced to `brain.md` or a canonical document,
  delete it.
