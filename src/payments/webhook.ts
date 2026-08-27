// Exactly-once external ingestion (hard rule 4): idempotency key +
// dead-letter + replay. Vendor webhook payloads are normalized by the future
// Stripe adapter into this owned envelope before they reach the ingestor —
// vendor semantics never leak past the adapter boundary.

export interface WebhookEnvelope {
  /** Vendor delivery id — the idempotency key for ingestion. */
  id: string;
  type: string;
  data: Record<string, unknown>;
}

export interface DeadLetter {
  raw: string;
  reason: string;
  at: Date;
}

export type WebhookHandler = (envelope: WebhookEnvelope) => Promise<void>;

export type IngestResult =
  | { status: "processed" }
  | { status: "duplicate" }
  | { status: "dead_lettered"; reason: string };

export class WebhookIngestor {
  private handlers = new Map<string, WebhookHandler>();
  private processed = new Set<string>();
  private letters = new Map<string, DeadLetter>();
  private nextLetterId = 1;

  on(type: string, handler: WebhookHandler): void {
    this.handlers.set(type, handler);
  }

  async ingest(raw: string, now: Date = new Date()): Promise<IngestResult> {
    let envelope: WebhookEnvelope;
    try {
      const parsed = JSON.parse(raw) as Partial<WebhookEnvelope>;
      if (typeof parsed.id !== "string" || !parsed.id.trim()) throw new Error("missing id");
      if (typeof parsed.type !== "string" || !parsed.type.trim()) throw new Error("missing type");
      envelope = { id: parsed.id, type: parsed.type, data: parsed.data ?? {} };
    } catch (err) {
      return this.deadLetter(raw, `malformed: ${(err as Error).message}`, now);
    }

    if (this.processed.has(envelope.id)) return { status: "duplicate" };

    const handler = this.handlers.get(envelope.type);
    if (!handler) return this.deadLetter(raw, `no handler for type ${envelope.type}`, now);

    try {
      await handler(envelope);
    } catch (err) {
      // Handler failure is retryable — dead-letter, do NOT mark processed.
      return this.deadLetter(raw, `handler failed: ${(err as Error).message}`, now);
    }
    this.processed.add(envelope.id);
    return { status: "processed" };
  }

  deadLetters(): Array<{ letterId: string } & DeadLetter> {
    return [...this.letters.entries()].map(([letterId, letter]) => ({ letterId, ...letter }));
  }

  /** Re-attempt one dead letter (e.g. after registering a missing handler). */
  async replay(letterId: string, now: Date = new Date()): Promise<IngestResult> {
    const letter = this.letters.get(letterId);
    if (!letter) return { status: "dead_lettered", reason: "unknown letter id" };
    const result = await this.ingest(letter.raw, now);
    if (result.status !== "dead_lettered") this.letters.delete(letterId);
    return result;
  }

  private deadLetter(raw: string, reason: string, at: Date): IngestResult {
    this.letters.set(`dl-${this.nextLetterId++}`, { raw, reason, at });
    return { status: "dead_lettered", reason };
  }
}
