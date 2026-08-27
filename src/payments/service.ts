// Payment lifecycle on the evidence spine: intent BEFORE the rail is
// touched, then a succeeded/failed record. Cost-per-incident becomes
// derivable from stored events the day real money flows.
import type { EvidenceStore } from "../common/evidence/store.js";
import type { EvidenceEvent } from "../common/evidence/types.js";
import { CALCULATION_RULES_VERSION } from "../common/evidence/rules.js";
import type { ChargeResult, PaymentsAdapter } from "./adapter.js";

export interface ChargeRequestInput {
  memberId: string;
  requestId: string;
  amountCents: number;
  currency: string;
}

export class PaymentValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PaymentValidationError";
  }
}

export class PaymentsService {
  constructor(
    private readonly evidence: EvidenceStore,
    private readonly adapter: PaymentsAdapter,
    private readonly onEvent?: (event: EvidenceEvent) => void
  ) {}

  async chargeForRequest(
    input: ChargeRequestInput,
    chargeKey: string,
    now: Date = new Date()
  ): Promise<ChargeResult> {
    if (!Number.isInteger(input.amountCents) || input.amountCents <= 0) {
      throw new PaymentValidationError("amountCents must be a positive integer");
    }
    if (!/^[a-z]{3}$/i.test(input.currency)) {
      throw new PaymentValidationError("currency must be a 3-letter code");
    }
    if (!chargeKey.trim()) throw new PaymentValidationError("chargeKey required");

    // If this key already reached an outcome, return it — no second charge,
    // no duplicate evidence (crash-recovery included).
    const prior = await this.priorOutcome(input.requestId, chargeKey);
    if (prior) return prior;

    const intent = await this.evidence.append({
      requestId: input.requestId,
      eventType: "payment.intent_created",
      payload: {
        memberId: input.memberId,
        amountCents: input.amountCents,
        currency: input.currency.toLowerCase(),
        chargeKey,
      },
      actorType: "system",
      actorId: "payments",
      calculationRulesVersion: CALCULATION_RULES_VERSION,
      idempotencyKey: `payment.intent:${input.requestId}:${chargeKey}`,
      occurredAt: now,
    });
    this.onEvent?.(intent);

    const result = await this.adapter.charge({
      memberId: input.memberId,
      requestId: input.requestId,
      amountCents: input.amountCents,
      currency: input.currency.toLowerCase(),
      idempotencyKey: chargeKey,
    });

    const outcome = await this.evidence.append({
      requestId: input.requestId,
      eventType: result.ok ? "payment.succeeded" : "payment.failed",
      payload: result.ok
        ? { chargeKey, providerRef: result.providerRef, amountCents: input.amountCents, currency: input.currency.toLowerCase() }
        : { chargeKey, failureReason: result.failureReason, amountCents: input.amountCents, currency: input.currency.toLowerCase() },
      actorType: "system",
      actorId: "payments",
      calculationRulesVersion: CALCULATION_RULES_VERSION,
      idempotencyKey: `payment.result:${input.requestId}:${chargeKey}`,
      occurredAt: now,
    });
    this.onEvent?.(outcome);
    return result;
  }

  private async priorOutcome(requestId: string, chargeKey: string): Promise<ChargeResult | null> {
    const timeline = await this.evidence.timeline(requestId);
    for (const event of timeline) {
      const p = event.payload as { chargeKey?: string; providerRef?: string; failureReason?: string };
      if (p.chargeKey !== chargeKey) continue;
      if (event.eventType === "payment.succeeded") return { ok: true, providerRef: p.providerRef! };
      if (event.eventType === "payment.failed") return { ok: false, failureReason: p.failureReason! };
    }
    return null;
  }
}
