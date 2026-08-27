// Request lifecycle. The transition map IS the state machine — there is no
// other place a status change can be declared legal. "triaged → resolved" is
// deliberate: the doctrine prefers remote/software resolution before
// dispatching metal.
import type { ActorType } from "../common/evidence/types.js";

export const REQUEST_STATUSES = [
  "created",
  "triaged",
  "matched",
  "en_route",
  "on_scene",
  "resolved",
  "closed",
  "cancelled",
] as const;
export type RequestStatus = (typeof REQUEST_STATUSES)[number];

export const TRANSITIONS: Record<RequestStatus, RequestStatus[]> = {
  created: ["triaged", "cancelled"],
  triaged: ["matched", "resolved", "cancelled"], // resolved = remote close
  matched: ["en_route", "cancelled"],
  en_route: ["on_scene", "cancelled"],
  on_scene: ["resolved"],
  resolved: ["closed"],
  closed: [],
  cancelled: [],
};

// Which populations may drive each transition. Members request and cancel;
// triage/matching/remote-close are system (agent/matching engine) or ops;
// the physical journey is the provider's. Structural, not conventional.
export const TRANSITION_ACTORS: Record<RequestStatus, ActorType[]> = {
  created: ["member"],
  triaged: ["system", "ops"],
  matched: ["system", "ops"],
  en_route: ["provider"],
  on_scene: ["provider"],
  resolved: ["provider", "system", "ops"],
  closed: ["system", "ops"],
  cancelled: ["member", "ops"],
};

export interface RequestRecord {
  id: string;
  memberId: string;
  serviceType: string;
  city: string;
  lat: number;
  lng: number;
  status: RequestStatus;
  vehicleId?: string;
  createdAt: Date;
  updatedAt: Date;
}

export class RequestValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RequestValidationError";
  }
}

export class IllegalTransitionError extends Error {
  constructor(
    public readonly from: RequestStatus,
    public readonly to: RequestStatus,
    public readonly reason: "illegal_transition" | "wrong_actor_population" | "not_assigned_provider"
  ) {
    super(`cannot transition ${from} → ${to} (${reason})`);
    this.name = "IllegalTransitionError";
  }
}

export class RequestNotFoundError extends Error {
  constructor(id: string) {
    super(`request ${id} not found`);
    this.name = "RequestNotFoundError";
  }
}
