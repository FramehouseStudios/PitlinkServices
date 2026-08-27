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

## Candidate hosts [RECOMMENDATION — not purchased]

Ordered by least ops burden. All are single-region, which is correct until a
measured latency/availability trigger (Blueprint §13).

1. **Fly.io** — container-native, managed Postgres, Upstash Redis; cheapest
   path to a real URL. Good default for the beachhead.
2. **Render** — managed Postgres + Redis in one dashboard, deploy from the
   repo; slightly more expensive, least fiddly.
3. **AWS (ECS Fargate + RDS + ElastiCache)** — most control and most ops
   work. Choose only if compliance or existing credits demand it.

Selection, pricing, and the domain are founder decisions.

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
