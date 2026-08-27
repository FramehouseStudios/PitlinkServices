// Owned payments contract. Stripe (DECIDED as the rail in the canonical
// docs) will implement this behind an adapter file when keys and commercial
// terms exist — domain code never sees a vendor SDK, and no amount is ever a
// constant (pricing/packaging is an open founder RFI).

export interface ChargeInput {
  memberId: string;
  requestId: string;
  amountCents: number;
  currency: string;
  /** Exactly-once: the same key can never charge twice. */
  idempotencyKey: string;
}

export type ChargeResult =
  | { ok: true; providerRef: string }
  | { ok: false; failureReason: string };

export interface PaymentsAdapter {
  charge(input: ChargeInput): Promise<ChargeResult>;
}

/**
 * Deterministic Phase 0 implementation. Succeeds by default; a charge whose
 * idempotencyKey is registered via failNext() fails with that reason —
 * letting tests exercise every failure path without a vendor. Idempotent:
 * a replayed key returns the original result without a second "charge".
 */
export class FakePaymentsAdapter implements PaymentsAdapter {
  readonly charges: ChargeInput[] = [];
  private results = new Map<string, ChargeResult>();
  private failures = new Map<string, string>();
  private crashOnce = new Set<string>();

  failNext(idempotencyKey: string, reason: string): void {
    this.failures.set(idempotencyKey, reason);
  }

  /** Simulate an infrastructure crash (thrown error) on first attempt. */
  crashNext(idempotencyKey: string): void {
    this.crashOnce.add(idempotencyKey);
  }

  async charge(input: ChargeInput): Promise<ChargeResult> {
    const existing = this.results.get(input.idempotencyKey);
    if (existing) return existing;
    if (this.crashOnce.delete(input.idempotencyKey)) {
      throw new Error("payment rail unreachable");
    }
    this.charges.push({ ...input });
    const failure = this.failures.get(input.idempotencyKey);
    const result: ChargeResult = failure
      ? { ok: false, failureReason: failure }
      : { ok: true, providerRef: `fake_${input.idempotencyKey}` };
    this.results.set(input.idempotencyKey, result);
    return result;
  }
}
