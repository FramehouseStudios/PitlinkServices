# PitlinkServices

AI-native mobility assistance platform. **Make being stranded a solved problem.**

Pitlink turns being stranded into a solved problem: fast, reliable, intelligent
roadside and mobility help through conversational agents, real-time matching,
and a provider marketplace. This repo is the modular monolith described in the
canonical documents (Founder Product Brief, Platform Proposal, Technical
Architecture Blueprint) — those documents are the single source of truth.

## Status

**Phase 0 — Foundation.** Exit criterion: an end-to-end request can be created,
matched (mock or live), tracked, and closed with stored evidence events that
produce a reproducible timeline.

Runtime: **Node.js + TypeScript** [DECIDED — founder, 2026-08-26].

## Architecture in one paragraph

Modular monolith (single deployable), PostgreSQL as source of truth with an
**append-only evidence spine** (`evidence_events`), Redis for presence/queues,
REST + WebSockets surfaces, and owned adapters for every vendor (maps, LLM,
Stripe, telephony). **Contract Gate:** no domain code imports vendor SDKs
directly. Every metric-affecting state change emits an evidence event *before*
side effects; corrections are compensating events. Member, provider, and ops
identities are structurally isolated.

## Layout

```
src/
  common/     shared kernel: config, evidence spine, (later) db, auth
  agents/     conversational AI orchestration (tool-calling loop)
  matching/   request → provider matching & dispatch
  realtime/   presence, live tracking, WebSocket status
  providers/  provider marketplace (identity, verification, offers)
  payments/   Stripe membership / per-incident (behind owned adapter)
migrations/   forward-only SQL migrations
scripts/      operational scripts (migrate)
```

## Getting started

```bash
npm install
cp .env.example .env        # fill in values; never commit .env
docker compose up -d        # local Postgres + Redis
npm run migrate
npm test
```

## Ground rules for contributors (human or agent)

- Canonical documents override everything in this README.
- Never hard-code open commercial decisions (pricing, payout, density targets,
  voice provider, LLM routing) — they live in env/config.
- Evidence before side effects; append-only; idempotency keys on ingestion.
- No secrets, payment data, or unnecessary PII in logs.
- Smallest system that proves the next phase gate; complexity requires a
  measured trigger (see Blueprint §13).
- See `docs/HANDOFF.md` for current state and next task.
