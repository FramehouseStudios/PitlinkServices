import type { EvidenceStore } from "./store.js";
import { validateNewEvent, type EvidenceEvent, type NewEvidenceEvent } from "./types.js";

function copy(event: EvidenceEvent): EvidenceEvent {
  return { ...event, payload: structuredClone(event.payload) };
}

// In-memory implementation for tests and mocked Phase 0 flows. Mirrors the
// Postgres semantics: append-only, idempotent on idempotencyKey.
export class InMemoryEvidenceStore implements EvidenceStore {
  private events: EvidenceEvent[] = [];
  private byIdempotencyKey = new Map<string, EvidenceEvent>();
  private nextId = 1;

  async append(event: NewEvidenceEvent): Promise<EvidenceEvent> {
    validateNewEvent(event);
    const existing = this.byIdempotencyKey.get(event.idempotencyKey);
    if (existing) return copy(existing);

    const stored: EvidenceEvent = {
      ...event,
      payload: structuredClone(event.payload),
      id: this.nextId++,
      recordedAt: new Date(),
    };
    this.events.push(stored);
    this.byIdempotencyKey.set(stored.idempotencyKey, stored);
    // Callers get a copy: mutating a returned event must never reach the spine.
    return copy(stored);
  }

  async timeline(requestId: string): Promise<EvidenceEvent[]> {
    return this.events
      .filter((e) => e.requestId === requestId)
      .sort((a, b) => a.occurredAt.getTime() - b.occurredAt.getTime() || a.id - b.id)
      .map(copy);
  }
}
