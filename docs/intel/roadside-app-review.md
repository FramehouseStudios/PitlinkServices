# Intelligence memo — FramehouseStudios/roadside-app review

- **Date:** 2026-08-26
- **Source:** https://github.com/FramehouseStudios/roadside-app (fork of
  `aaazureee/roadside-app`), cloned locally to `~/roadside-app`.
- **What it is:** an older reference implementation of an Uber-like roadside
  marketplace — NestJS + TypeORM/PostGIS backend, CRA/Material-UI client,
  session auth. VERIFIED by direct code read.

## Verdict [RECOMMENDATION — adopted under CEO autonomy mandate]

**Mine it, do not merge it.** The stack is generationally old (CRA, tslint,
TypeORM 0.2-era) and its core design violates two Pitlink hard rules: a
single `user` table with a role enum (`admin | customer | professional`) —
exactly the shared-identity anti-pattern our isolation invariant forbids —
and raw credit-card storage in its own DB (`credit-card.entity.ts`), which
Pitlink must never do (payments stay behind the Stripe adapter, out of PCI
scope). No code is imported. Its value is domain intelligence.

## Domain findings worth acting on

1. **Bidding vs dispatch marketplace model.** Its flow is
   `SUBMITTED → WAITING_CUSTOMER_SELECTION → IN_PROGRESS → COMPLETED`, with a
   `CalloutMatching(calloutId, professionalId, accepted, proposedPrice)`
   table: providers bid a price, the customer picks. Pitlink's canonical
   model is platform-dispatch (nearest capable provider, platform-set
   pricing). The bid model is a real alternative with different unit
   economics (price discovery vs speed/consistency). `UNKNOWN_RFI` — this
   belongs inside the founder's pricing/payout decision; our
   offer/accept evidence events (`provider.offered`/`provider.accepted`)
   already leave room for a multi-offer flow if that door is ever opened.
   Until then dispatch remains the DECIDED-by-docs default.
2. **Vehicle as a first-class entity** (make/model/plate, owned by the
   member, attached to each callout). Triage needs this (EV vs ICE changes
   the fuel/charge service; tow needs vehicle class). BACKLOG: add a
   `vehicles` bounded context to the member profile before Phase 1 live
   operations; attach `vehicleId` to request creation as an optional field.
3. **Post-resolution review** (rating + comment on the callout, both
   directions customer↔professional). Matches the canonical journey's
   "post-resolution feedback" step and feeds provider quality — BACKLOG for
   the reconciliation increment: `request.feedback` evidence event carrying
   rating/comment, provider quality derivable from the spine.
4. **Price on the callout record.** It stores a bare integer with no
   lineage. Ours must be: amount parameterized (no constants), lifecycle on
   the evidence spine — which increment 7 implements.

## What we explicitly reject

- Shared user table + role column (isolation anti-pattern).
- Card details in our database (PCI scope; hard rule).
- Session-cookie auth for our API (we are JWT + population claim).
- Adopting its client code (CRA is deprecated; our member surface will be
  built fresh, web/voice-first per the canonical docs).
