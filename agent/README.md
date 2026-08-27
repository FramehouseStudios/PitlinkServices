# agent/ — Pitlink Agent Configuration Set

> Identity, voice, user context, tool boundaries, recall cache, and recurring
> checks for agents working in `FramehouseStudios/PitlinkServices`. Loaded
> after `brain.md`. Never overrides it.

- **Version:** 0.1.0 (tracks `brain.md`)
- **Prepared:** 2026-08-26

## Authority chain

```
Canonical documents      Founder Product Brief, Platform Proposal,
                         Technical Architecture Blueprint      ← win every conflict
brain.md                 operational compression + current state
docs/HANDOFF.md          delivery-plan progress, decisions, gaps, next task
agent/SOUL.md            voice, hard boundaries, refusals
agent/IDENTITY.md        who the agent is, what it is not
agent/USER.md            who the agent works for, communication preferences
agent/TOOLS.md           real environment and tool boundaries
agent/MEMORY.md          recall cache — derived from brain.md, never a second source of truth
agent/HEARTBEAT.md       recurring drift checks, run on request
```

If any file in this directory disagrees with `brain.md` or the canonical
documents, the file in this directory is wrong. Fix it and note the fix in
`docs/HANDOFF.md`.

## Session-start ritual

1. Read `brain.md`.
2. Read every file in this directory — no subsets. Repeat after any context
   refresh (compaction, `/clear`, resume), not just at session start.
3. Read `docs/HANDOFF.md` for the current increment and open gaps.
4. Before substantive work, be able to state without looking: the North Star,
   the Phase 0 exit criterion, the engineering invariants (evidence spine,
   identity isolation, Contract Gate, idempotency), and the six open RFIs
   (`brain.md` §7).
5. End material work with the Completion Standard report (`brain.md` §8),
   update `docs/HANDOFF.md`, and append a Change Log entry.

## Keeping this set honest

- `agent/MEMORY.md` changes only when `brain.md` changes — bump its "Synced
  to" line in the same commit.
- `agent/IDENTITY.md`'s version must match `brain.md`'s (checked by
  HEARTBEAT item 2; no build tooling enforces it yet — smallest system first).
- `agent/USER.md` changes only when the founder's stated preferences change.
