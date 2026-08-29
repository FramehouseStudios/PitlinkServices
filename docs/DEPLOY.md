# Deploying Pitlink

Pitlink is one container plus managed PostgreSQL and Redis. There is no
vendor lock-in: the app reads everything it needs from environment
variables, so any container host works.

**Nothing here has been purchased.** Choosing and paying for a host is a
founder decision; this document removes every engineering blocker so that
choice takes minutes.

## What you need

| Piece | Requirement |
|---|---|
| App | One container, HTTP on `PORT` (default 3000). Scale to 1 instance for now — see *Multi-instance* below. |
| PostgreSQL | 16+. Source of truth (evidence spine). Needs automated backups — the spine IS the business record. |
| Redis | 7+. Provider presence only; loss degrades matching until providers re-heartbeat, it does not lose evidence. |

## Required environment

```
NODE_ENV=production
DATABASE_URL=postgres://user:pass@host:5432/pitlink
REDIS_URL=redis://host:6379
JWT_SECRET=<openssl rand -base64 48>
JWT_EXPIRY=1h
DEFAULT_CITY=los-angeles
ENABLE_PREDICTIVE_ALERTS=false
ENABLE_PROVIDER_MARKETPLACE=true
```

**The app refuses to start in production on a weak `JWT_SECRET`** (under 32
chars, a known placeholder, or no entropy). This is deliberate: a guessable
signing secret is total account compromise across members, providers, and
ops. Generate one with `openssl rand -base64 48`.

Optional tuning (all ESTIMATEs, see `.env.example`): `RELIABILITY_*`,
`REPUTATION_*`, `SERVICE_TYPES`, `PUBLIC_DIR`, `PORT`.

## Deploy steps

```bash
docker build -t pitlink:latest .
# 1. Run migrations once against the production database:
DATABASE_URL=... REDIS_URL=... JWT_SECRET=... JWT_EXPIRY=1h \
  DEFAULT_CITY=los-angeles ENABLE_PREDICTIVE_ALERTS=false \
  ENABLE_PROVIDER_MARKETPLACE=true npm run migrate
# 2. Start the container with the environment above.
# 3. Seed the first ops account (never self-signup):
OPS_EMAIL=you@pitlink.com OPS_PASSWORD='...' npx tsx scripts/seed-ops.ts
```

`GET /health` returns 200 when PostgreSQL and Redis are both reachable, 503
otherwise — point the platform's health check at it. The image also carries
its own `HEALTHCHECK`.

The app handles `SIGTERM` gracefully: it stops the reliability sweep, drains
in-flight requests, closes Redis and PostgreSQL, then exits (15s cap). Any
platform that sends SIGTERM before SIGKILL will deploy without dropping a
member mid-request.

## Host recommendation [RECOMMENDATION — nothing purchased]

**Render.** Reasoning, researched 2026-08-27 against primary sources:

### The constraint that decides it

The reliability sweep runs **in-process on an interval** — it is what detects
no-show providers and rescues stranded requests. The host MUST run an
always-on persistent process. Anything that scales to zero or sleeps idle
instances silently breaks no-show recovery: the member sees "Matched" forever
and nobody is rescued. That eliminates Vercel, Netlify, Cloudflare Workers,
and **Render's own free tier**. Long-lived WebSockets for live tracking rule
out the same set.

Real choice: Render vs Fly.io. It comes down to the database.

### Why Render

- **Cost on the dominant line item.** Fly Managed Postgres starts at $38/mo
  (Basic). Render Postgres starts ~$7/mo, with Basic-1GB ~$20/mo — which is
  what to pick, since the evidence spine grows. Roughly half, all in.
- **PITR where we need it.** Render's docs confirm point-in-time recovery on
  ALL paid plans (3-day window on Hobby, 7-day on Pro) plus logical backups
  retained 7 days. NOTE: a third-party blog claims PITR needs the $95
  Standard tier — contradicted by Render's own documentation; primary source
  wins. This matters because `evidence_events` is the only record that can
  prove anything about the business.
- **One vendor, one dashboard** for app + Postgres + Redis. A solo founder's
  scarcest resource is attention. Fly also added billing complexity in 2026
  (volume snapshots billed per GB; inter-region traffic billed from February).
- **The LAX argument does not hold.** Fly has a Los Angeles region; Render's
  nearest is Oregon. But the North Star is measured in MINUTES TO ARRIVAL —
  20ms of network latency is irrelevant to it, while an afternoon of database
  ops is not.

### What to provision

- Web service: **paid** starter tier — never the free tier (it sleeps).
- Postgres: **Basic-1GB** (~$20/mo). Workspace on Hobby to start; upgrade to
  Pro before the first PAYING member to widen PITR from 3 to 7 days.
- Key Value (Redis): smallest paid instance.
- Region: **Oregon**. Deploy from the `Dockerfile` in this repo.

**ESTIMATE ~$35–50/month** all in. Verify at signup; pricing moves.

### When to revisit

If multi-region or edge presence is ever needed, Fly is the better
architecture. That is a Phase 3 trigger (Blueprint §13), not a today decision.

Sources: https://render.com/docs/postgresql-backups · https://fly.io/docs/mpg/
· https://fly.io/docs/about/pricing/

## Multi-instance (not yet)

The reliability sweep and the WebSocket event bus are in-process by design
(Blueprint §13: no speculative complexity). Running two instances today
would double-run the sweep and split WS subscribers. Before scaling out:
elect a leader for the sweep (or move it to a scheduled worker) and move the
bus to Redis pub/sub. The trigger is a measured CPU/latency ceiling on one
instance — not a hunch.

## Backups and evidence

`evidence_events` is append-only and is the only record from which metrics,
money, and incident history can be reproduced. Enable automated daily
backups with point-in-time recovery before the first paying member. Losing
this table means losing the ability to prove anything about the business.
