// Request lifecycle service. The one rule that shapes every method: the
// evidence event is appended BEFORE the read-model side effect. If we crash
// in between, the spine is right and the projection heals on the next read.
import { randomUUID } from "node:crypto";
import type { EvidenceStore } from "../common/evidence/store.js";
import type { ActorType, EvidenceEvent } from "../common/evidence/types.js";
import { CALCULATION_RULES_VERSION } from "../common/evidence/rules.js";
import type { RequestStore } from "./store.js";
import {
  IllegalTransitionError,
  RequestNotFoundError,
  RequestValidationError,
  TRANSITIONS,
  TRANSITION_ACTORS,
  type RequestRecord,
  type RequestStatus,
} from "./types.js";

export interface Actor {
  type: ActorType;
  id: string;
}

export interface CreateRequestInput {
  serviceType: string;
  city: string;
  lat: number;
  lng: number;
  /** Ownership must be verified by the caller (API resolves via findOwned).
   * The snapshot goes into the creation event so triage context is
   * reproducible even if the vehicle record later changes. */
  vehicle?: { id: string; make: string; model: string; powertrain: string };
}

export class RequestService {
  constructor(
    private readonly evidence: EvidenceStore,
    private readonly requests: RequestStore,
    private readonly serviceTypes: readonly string[],
    /** Notified after each NEW spine event (replays excluded) — realtime push. */
    private readonly onEvent?: (event: EvidenceEvent) => void
  ) {}

  async create(
    actor: Actor,
    input: CreateRequestInput,
    idempotencyKey: string,
    now: Date = new Date()
  ): Promise<RequestRecord> {
    if (actor.type !== "member") {
      throw new IllegalTransitionError("created", "created", "wrong_actor_population");
    }
    if (!this.serviceTypes.includes(input.serviceType)) {
      throw new RequestValidationError(
        `unknown serviceType ${JSON.stringify(input.serviceType)}; known: ${this.serviceTypes.join(", ")}`
      );
    }
    if (!input.city.trim()) throw new RequestValidationError("city must be non-empty");
    if (!Number.isFinite(input.lat) || input.lat < -90 || input.lat > 90) {
      throw new RequestValidationError("lat out of range");
    }
    if (!Number.isFinite(input.lng) || input.lng < -180 || input.lng > 180) {
      throw new RequestValidationError("lng out of range");
    }
    if (!idempotencyKey.trim()) throw new RequestValidationError("idempotencyKey required");

    const requestId = randomUUID();
    const event = await this.evidence.append({
      requestId,
      eventType: "request.created",
      payload: {
        serviceType: input.serviceType,
        city: input.city,
        lat: input.lat,
        lng: input.lng,
        ...(input.vehicle ? { vehicle: input.vehicle } : {}),
      },
      actorType: actor.type,
      actorId: actor.id,
      calculationRulesVersion: CALCULATION_RULES_VERSION,
      idempotencyKey: `request.create:${idempotencyKey}`,
      occurredAt: now,
    });

    // Replay: the spine already holds a creation under this key — return that
    // request, healing the projection from the event if the row is missing.
    const canonicalId = event.requestId;
    if (canonicalId !== requestId) return this.heal(canonicalId, event, actor.id);
    this.onEvent?.(event);

    const record: RequestRecord = {
      id: requestId,
      memberId: actor.id,
      serviceType: input.serviceType,
      city: input.city,
      lat: input.lat,
      lng: input.lng,
      status: "created",
      ...(input.vehicle ? { vehicleId: input.vehicle.id } : {}),
      createdAt: now,
      updatedAt: now,
    };
    await this.requests.insert(record);
    return record;
  }

  /**
   * Post-resolution feedback: the owning member, once, after resolution.
   * One feedback per request — a replay returns the original event.
   */
  async feedback(
    actor: Actor,
    requestId: string,
    rating: number,
    comment?: string,
    now: Date = new Date()
  ): Promise<EvidenceEvent> {
    const record = await this.requests.findById(requestId);
    // Identity before state: non-owners learn nothing, not even existence.
    if (!record || actor.type !== "member" || actor.id !== record.memberId) {
      throw new RequestNotFoundError(requestId);
    }
    if (record.status !== "resolved" && record.status !== "closed") {
      throw new RequestValidationError("feedback is accepted only after resolution");
    }
    if (!Number.isInteger(rating) || rating < 1 || rating > 5) {
      throw new RequestValidationError("rating must be an integer from 1 to 5");
    }
    if (comment !== undefined && comment.length > 2000) {
      throw new RequestValidationError("comment too long");
    }
    const existing = (await this.evidence.timeline(requestId)).find(
      (e) => e.eventType === "request.feedback"
    );
    if (existing) return existing;

    const providerId = await this.assignedProvider(requestId);
    const event = await this.evidence.append({
      requestId,
      eventType: "request.feedback",
      payload: { rating, ...(comment ? { comment } : {}), ...(providerId ? { providerId } : {}) },
      actorType: "member",
      actorId: actor.id,
      calculationRulesVersion: CALCULATION_RULES_VERSION,
      idempotencyKey: `feedback:${requestId}`,
      occurredAt: now,
    });
    this.onEvent?.(event);
    return event;
  }

  async transition(
    actor: Actor,
    requestId: string,
    to: RequestStatus,
    idempotencyKey: string,
    now: Date = new Date()
  ): Promise<RequestRecord> {
    const record = await this.requests.findById(requestId);
    if (!record) throw new RequestNotFoundError(requestId);
    if (record.status === to) return record; // idempotent no-op

    const from = record.status;
    const deny = async (reason: "illegal_transition" | "wrong_actor_population" | "not_assigned_provider") => {
      // Hard rule 10: privileged-write denials are audited — on the spine,
      // request-scoped, before the error surfaces.
      const denial = await this.evidence.append({
        requestId,
        eventType: "request.transition_denied",
        payload: { from, to, reason },
        actorType: actor.type,
        actorId: actor.id,
        calculationRulesVersion: CALCULATION_RULES_VERSION,
        idempotencyKey: `request.denied:${randomUUID()}`,
        occurredAt: now,
      });
      this.onEvent?.(denial);
      throw new IllegalTransitionError(from, to, reason);
    };

    // Identity checks come BEFORE state-machine checks: an actor with no
    // right to this request must learn nothing about its state from the
    // error they receive.
    if (!TRANSITION_ACTORS[to].includes(actor.type)) await deny("wrong_actor_population");
    // A member may only act on their own request.
    if (actor.type === "member" && actor.id !== record.memberId) await deny("wrong_actor_population");
    // A provider may only act on a request they were assigned to — the
    // spine's provider.accepted event is the source of truth for assignment.
    if (actor.type === "provider" && (await this.assignedProvider(requestId)) !== actor.id) {
      await deny("not_assigned_provider");
    }
    if (!TRANSITIONS[from].includes(to)) await deny("illegal_transition");

    const nonce = randomUUID();
    const event = await this.evidence.append({
      requestId,
      eventType: `request.${to}`,
      payload: { from, nonce },
      actorType: actor.type,
      actorId: actor.id,
      calculationRulesVersion: CALCULATION_RULES_VERSION,
      // Scoped by request id: the same client key on two different requests
      // must never collide into a silent no-op.
      idempotencyKey: `request.transition:${requestId}:${to}:${idempotencyKey}`,
      occurredAt: now,
    });
    if ((event.payload as { nonce?: string }).nonce !== nonce) {
      // Replay of an earlier successful transition under the same key.
      return (await this.requests.findById(requestId))!;
    }
    this.onEvent?.(event);

    const updated = await this.requests.setStatus(requestId, from, to, now);
    if (!updated) {
      const current = await this.requests.findById(requestId);
      if (current?.status === to) return current; // lost a benign race
      throw new IllegalTransitionError(current?.status ?? from, to, "illegal_transition");
    }
    return { ...record, status: to, updatedAt: now };
  }

  async get(requestId: string): Promise<RequestRecord | null> {
    return this.requests.findById(requestId);
  }

  async listRecent(limit: number): Promise<RequestRecord[]> {
    return this.requests.listRecent(limit);
  }

  async timeline(requestId: string): Promise<EvidenceEvent[]> {
    return this.evidence.timeline(requestId);
  }

  /** Provider assigned by the most recent provider.accepted event, if any. */
  async assignedProvider(requestId: string): Promise<string | null> {
    const timeline = await this.evidence.timeline(requestId);
    for (let i = timeline.length - 1; i >= 0; i--) {
      const event = timeline[i]!;
      if (event.eventType === "provider.accepted") {
        return (event.payload as { providerId?: string }).providerId ?? event.actorId;
      }
    }
    return null;
  }

  /** Rebuild a missing projection row from its creation event. */
  private async heal(id: string, event: EvidenceEvent, memberId: string): Promise<RequestRecord> {
    const existing = await this.requests.findById(id);
    if (existing) return existing;
    const p = event.payload as { serviceType: string; city: string; lat: number; lng: number };
    const record: RequestRecord = {
      id,
      memberId,
      serviceType: p.serviceType,
      city: p.city,
      lat: p.lat,
      lng: p.lng,
      status: "created",
      createdAt: event.occurredAt,
      updatedAt: event.occurredAt,
    };
    await this.requests.insert(record);
    return record;
  }
}
