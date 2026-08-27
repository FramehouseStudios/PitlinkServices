import type { EvidenceEvent, NewEvidenceEvent } from "./types.js";

// The only write operation is append. There is deliberately no update or
// delete on this interface: corrections are compensating events, and the DB
// enforces the same rule with a trigger (migrations/001).
export interface EvidenceStore {
  /**
   * Append an event. Idempotent: appending with an idempotencyKey that was
   * already recorded returns the original stored event unchanged.
   */
  append(event: NewEvidenceEvent): Promise<EvidenceEvent>;

  /** Full reproducible timeline for a request, ordered by occurredAt then id. */
  timeline(requestId: string): Promise<EvidenceEvent[]>;
}
