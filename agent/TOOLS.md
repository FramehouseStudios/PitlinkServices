# TOOLS.md — Environment & Tool Boundaries

> The real environment the Pitlink agent runs in, what it may use, and where
> the hard edges are.

- **As of:** 2026-08-26

## Active environment

- Platform: macOS (founder's machine), shell `zsh`.
- Harness: Claude Code, working directory `~/Pitlink Services` (path contains
  a space — always quote it).
- Remote: `https://github.com/FramehouseStudios/PitlinkServices.git`, branch
  `main`. Push access verified 2026-08-26.
- No access to production systems, live payment processing, or customer data
  (none exist yet). Any future grant must be recorded here first, with auth
  method and data-handling rules — especially for payment data and PII.

## Repository commands

```
npm test                             vitest suite (integration tests auto-skip
                                     without DATABASE_URL)
npx tsc --noEmit                     type check
docker compose up -d                 local Postgres 16 + Redis 7
npm run migrate                      forward-only SQL migrations
DATABASE_URL=postgres://pitlink:pitlink@localhost:5432/pitlink npm test
                                     full suite incl. live-Postgres integration
```

Run the type check and the test suite before declaring any repo-touching work
done. A VERIFY step that claims "tests pass" must have run them this session.

## Permitted tool categories

1. **Filesystem** — read/write/edit inside the repository and explicitly
   granted directories.
2. **Shell** — tests, type-check, migrations, docker compose, git. Nothing
   destructive outside the workspace without explicit approval.
3. **Web lookup** — official vendor API documentation (Stripe, Mapbox,
   OpenAI, telephony candidates) and primary sources only. Marketing pages
   are claims to be tested, never sources.
4. **Code intelligence / subagents** — search, analysis, fan-out reading,
   adversarial verification passes; conclusions still carry evidence labels.

## Explicit boundaries

- **Contract Gate:** vendor SDKs may be added as dependencies only inside
  owned adapter modules — never imported by domain code. `pg` (the Postgres
  driver) and `node:crypto` are infrastructure, not vendor SDKs.
- No storing or logging of secrets, API keys, payment data, or unnecessary
  PII. Secrets live in `.env` (git-ignored) / a secret manager.
- Commit only verified work; push per the founder's standing sync instruction
  (see `agent/USER.md`).
- Prefer deterministic local verification (tests, type check) over external
  side effects.
- Idempotency and isolation claims are exercised with real tests, never
  asserted from reading. The live-Postgres integration suite exists for this.
