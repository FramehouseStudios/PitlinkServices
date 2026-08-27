// THE material metrics, as pure, versioned functions over stored evidence.
// A skeptical third party reproduces any published number by running these
// functions against the spine — that is the company's definition of proof.
// Bump METRIC_RULES_VERSION whenever any formula here changes meaning.
import type { EvidenceEvent } from "../evidence/types.js";

export const METRIC_RULES_VERSION = "2026-08-26.v1";

function at(timeline: EvidenceEvent[], eventType: string): Date | null {
  const event = timeline.find((e) => e.eventType === eventType);
  return event ? event.occurredAt : null;
}

function minutesBetween(a: Date, b: Date): number {
  return (b.getTime() - a.getTime()) / 60000;
}

/** created → on_scene. Null until the provider has arrived. */
export function requestToArrivalMinutes(timeline: EvidenceEvent[]): number | null {
  const created = at(timeline, "request.created");
  const onScene = at(timeline, "request.on_scene");
  return created && onScene ? minutesBetween(created, onScene) : null;
}

/** created → resolved (remote or on-scene). Null until resolved. */
export function requestToResolutionMinutes(timeline: EvidenceEvent[]): number | null {
  const created = at(timeline, "request.created");
  const resolved = at(timeline, "request.resolved");
  return created && resolved ? minutesBetween(created, resolved) : null;
}

/** created → matched. Null until matched. */
export function requestToMatchMinutes(timeline: EvidenceEvent[]): number | null {
  const created = at(timeline, "request.created");
  const matched = at(timeline, "request.matched");
  return created && matched ? minutesBetween(created, matched) : null;
}

/** Resolved with no dispatch (no en_route event) — the software-before-metal rate. */
export function isRemoteResolution(timeline: EvidenceEvent[]): boolean | null {
  if (!at(timeline, "request.resolved")) return null;
  return at(timeline, "request.en_route") === null;
}

/** Sum of successful charges on this request, by currency. */
export function paidCentsByCurrency(timeline: EvidenceEvent[]): Record<string, number> {
  const totals: Record<string, number> = {};
  for (const event of timeline) {
    if (event.eventType !== "payment.succeeded") continue;
    const p = event.payload as { amountCents?: number; currency?: string };
    if (typeof p.amountCents === "number" && typeof p.currency === "string") {
      totals[p.currency] = (totals[p.currency] ?? 0) + p.amountCents;
    }
  }
  return totals;
}

/** Standard median: mean of the two middle values for even counts. */
export function median(values: number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2;
}

export interface FleetMetrics {
  rulesVersion: string;
  requestCount: number;
  medianRequestToArrivalMinutes: number | null;
  medianRequestToResolutionMinutes: number | null;
  medianRequestToMatchMinutes: number | null;
  /** resolved-without-dispatch / resolved. Null when nothing resolved. */
  remoteResolutionRate: number | null;
  matchFailureCount: number;
}

/** The North Star report, computed from a set of request timelines. */
export function fleetMetrics(timelines: EvidenceEvent[][]): FleetMetrics {
  const arrivals: number[] = [];
  const resolutions: number[] = [];
  const matches: number[] = [];
  let resolved = 0;
  let remote = 0;
  let matchFailures = 0;
  for (const timeline of timelines) {
    const arrival = requestToArrivalMinutes(timeline);
    if (arrival !== null) arrivals.push(arrival);
    const resolution = requestToResolutionMinutes(timeline);
    if (resolution !== null) resolutions.push(resolution);
    const match = requestToMatchMinutes(timeline);
    if (match !== null) matches.push(match);
    const isRemote = isRemoteResolution(timeline);
    if (isRemote !== null) {
      resolved++;
      if (isRemote) remote++;
    }
    matchFailures += timeline.filter((e) => e.eventType === "request.match_failed").length;
  }
  return {
    rulesVersion: METRIC_RULES_VERSION,
    requestCount: timelines.length,
    medianRequestToArrivalMinutes: median(arrivals),
    medianRequestToResolutionMinutes: median(resolutions),
    medianRequestToMatchMinutes: median(matches),
    remoteResolutionRate: resolved > 0 ? remote / resolved : null,
    matchFailureCount: matchFailures,
  };
}
