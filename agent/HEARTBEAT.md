# HEARTBEAT.md — Recurring Drift Checks

> Run when the founder asks ("run the heartbeat") or on a schedule they
> approve. Produce a short status report; take no irreversible action. If any
> item is red, surface it immediately rather than auto-fixing.

- **As of:** 2026-08-26

## Checklist

1. **Verification bar** — `npx tsc --noEmit` clean and `npm test` green
   (with `DATABASE_URL` set when the local stack is up, so the integration
   suite actually runs rather than skipping).

2. **Brain freshness** — `brain.md` §6 and `docs/HANDOFF.md` agree with
   `git log --oneline -10`; `agent/IDENTITY.md` and `agent/MEMORY.md`
   versions match `brain.md`'s.

3. **Open RFIs still open** — re-list the six `brain.md` §7 decisions.
   Confirm none has been silently "answered" in code, config, or docs. A
   hard-coded price, payout rate, density target, vendor choice, or model
   name is a red flag, not progress.

4. **Contract Gate** — grep `src/` for direct vendor SDK imports (stripe,
   openai, mapbox, twilio). Domain code must import only owned adapters.
   `pg` and `node:` builtins are infrastructure and exempt.

5. **Evidence-spine integrity** — no code path issues UPDATE/DELETE against
   `evidence_events`; the `EvidenceStore` interface still exposes only
   `append`/`timeline`; new metric-affecting state changes emit evidence
   before side effects.

6. **Identity isolation** — no new shared table, shared session surface, or
   privilege path between members, providers, and ops; `requirePrincipal`
   remains the single guard choke point; denials still audited.

7. **Complexity triggers** — no new document or dependency reintroduces
   microservices, Kafka, Kubernetes, native-app-first, or predictive
   pipelines without the Blueprint §13 written trigger.

8. **Secrets & PII hygiene** — `.env` still git-ignored; no secrets, payment
   data, or unnecessary PII in code, logs, or test fixtures.

## Future items (do not activate yet)

- Stripe webhook dead-letter health (once payments exist).
- Median request→arrival regression alert (once real events flow).
- Provider verification expiry checks (once a verification vendor is decided).
- Reconciliation job health (once money paths exist).
