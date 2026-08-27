// Reconciliation: the spine is the source of truth; the requests table is a
// projection. This derives the true status from events and reports any
// projection drift. Run it after incidents, on a schedule later — a
// discrepancy is a defect to investigate, never to silently repair.
import type { EvidenceEvent } from "../evidence/types.js";
import type { RequestRecord, RequestStatus } from "../../requests/types.js";

const LIFECYCLE_EVENTS: Record<string, RequestStatus> = {
  "request.created": "created",
  "request.triaged": "triaged",
  "request.matched": "matched",
  "request.en_route": "en_route",
  "request.on_scene": "on_scene",
  "request.resolved": "resolved",
  "request.closed": "closed",
  "request.cancelled": "cancelled",
};

/** True status per the spine: the last lifecycle event wins. */
export function deriveStatus(timeline: EvidenceEvent[]): RequestStatus | null {
  for (let i = timeline.length - 1; i >= 0; i--) {
    const status = LIFECYCLE_EVENTS[timeline[i]!.eventType];
    if (status) return status;
  }
  return null;
}

export type Reconciliation =
  | { consistent: true; status: RequestStatus }
  | {
      consistent: false;
      discrepancy: "missing_projection" | "status_drift" | "no_lifecycle_events";
      spineStatus: RequestStatus | null;
      projectionStatus: RequestStatus | null;
    };

export function reconcileRequest(
  timeline: EvidenceEvent[],
  projection: RequestRecord | null
): Reconciliation {
  const spineStatus = deriveStatus(timeline);
  if (spineStatus === null) {
    return {
      consistent: false,
      discrepancy: "no_lifecycle_events",
      spineStatus: null,
      projectionStatus: projection?.status ?? null,
    };
  }
  if (!projection) {
    return { consistent: false, discrepancy: "missing_projection", spineStatus, projectionStatus: null };
  }
  if (projection.status !== spineStatus) {
    return {
      consistent: false,
      discrepancy: "status_drift",
      spineStatus,
      projectionStatus: projection.status,
    };
  }
  return { consistent: true, status: spineStatus };
}
