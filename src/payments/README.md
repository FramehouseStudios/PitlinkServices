# payments module

Owned PaymentsAdapter contract (no Stripe SDK until keys + commercial terms
exist; amounts are always parameters), payment lifecycle on the evidence
spine, and exactly-once webhook ingestion with dead-letter + replay. See
docs/HANDOFF.md increment 7 notes.
