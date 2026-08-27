# CLAUDE.md — Session Entry Point

This is `FramehouseStudios/PitlinkServices` — Pitlink, the AI-native mobility
assistance platform. **Make being stranded a solved problem.**

Before doing anything else, in order:

1. Read `brain.md` — the operating brain (North Star, loop protocol, evidence
   discipline, architecture doctrine, current state, open RFIs).
2. Read every file in `agent/` — identity, soul, user context, tools, recall
   cache, heartbeat. No subsets.
3. Read `docs/HANDOFF.md` — delivery-plan progress and the next active task.

The three canonical documents (Founder Product Brief, Platform Proposal,
Technical Architecture Blueprint) override everything, `brain.md` compresses
them and wins over the rest of the repo.

Non-negotiables (details in `brain.md` §4–§5): append-only evidence spine
before side effects · structural member/provider/ops isolation · Contract
Gate (no vendor SDKs in domain code) · idempotent ingestion · no hard-coded
commercial decisions · smallest system that proves the next phase gate ·
every material task ends with the Completion Standard report (`brain.md` §8).

Verify with: `npx tsc --noEmit` and `npm test`
(`DATABASE_URL=postgres://pitlink:pitlink@localhost:5432/pitlink npm test`
for the live integration suite after `docker compose up -d && npm run migrate`).
