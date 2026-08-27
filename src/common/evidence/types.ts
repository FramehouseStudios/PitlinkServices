// The evidence spine's domain types. Structural identity separation: every
// event names its actor population explicitly.

export const ACTOR_TYPES = ["member", "provider", "ops", "system"] as const;
export type ActorType = (typeof ACTOR_TYPES)[number];

export interface NewEvidenceEvent {
  requestId: string;
  eventType: string;
  payload: Record<string, unknown>;
  actorType: ActorType;
  actorId: string;
  /** Version of the metric calculation rules in force when this was recorded. */
  calculationRulesVersion: string;
  /** Exactly-once: replays with the same key return the original event. */
  idempotencyKey: string;
  occurredAt: Date;
}

export interface EvidenceEvent extends NewEvidenceEvent {
  id: number;
  recordedAt: Date;
}

export class EvidenceValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "EvidenceValidationError";
  }
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function validateNewEvent(event: NewEvidenceEvent): void {
  if (!UUID_RE.test(event.requestId)) {
    throw new EvidenceValidationError(`requestId must be a UUID, got ${JSON.stringify(event.requestId)}`);
  }
  if (!event.eventType.trim()) throw new EvidenceValidationError("eventType must be non-empty");
  if (!ACTOR_TYPES.includes(event.actorType)) {
    throw new EvidenceValidationError(`actorType must be one of ${ACTOR_TYPES.join(", ")}`);
  }
  if (!event.actorId.trim()) throw new EvidenceValidationError("actorId must be non-empty");
  if (!event.calculationRulesVersion.trim()) {
    throw new EvidenceValidationError("calculationRulesVersion must be non-empty");
  }
  if (!event.idempotencyKey.trim()) throw new EvidenceValidationError("idempotencyKey must be non-empty");
  if (Number.isNaN(event.occurredAt.getTime())) {
    throw new EvidenceValidationError("occurredAt must be a valid date");
  }
}
