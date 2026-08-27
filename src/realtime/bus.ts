// In-process pub/sub for request lifecycle events. Deliberately not a
// message broker: single deployable, single process (Blueprint §13 — an
// event bus needs a measured trigger). The spine remains the source of
// truth; this only pushes what was already recorded.
import type { EvidenceEvent } from "../common/evidence/types.js";

export type RequestEventListener = (event: EvidenceEvent) => void;

export class RequestEventBus {
  private listeners = new Map<string, Set<RequestEventListener>>();

  publish(event: EvidenceEvent): void {
    const set = this.listeners.get(event.requestId);
    if (!set) return;
    for (const listener of set) {
      try {
        listener(event);
      } catch {
        // A broken subscriber must never break the publisher.
      }
    }
  }

  subscribe(requestId: string, listener: RequestEventListener): () => void {
    let set = this.listeners.get(requestId);
    if (!set) {
      set = new Set();
      this.listeners.set(requestId, set);
    }
    set.add(listener);
    return () => {
      set.delete(listener);
      if (set.size === 0) this.listeners.delete(requestId);
    };
  }
}
