// Automated alerts on service-quality regression (Blueprint §9). Pure
// functions over stored events: an alert is a claim about the business, so
// it must be reproducible like any other metric — and it names the numbers
// that produced it so nobody has to trust the alert blindly.
import type { EvidenceEvent } from "../common/evidence/types.js";
import { median, requestToArrivalMinutes } from "../common/metrics/calculations.js";

export interface ServiceHealthThresholds {
  /** Alert if median request→arrival exceeds this. ESTIMATE — the canonical
   * docs target sub-30-minute median in dense zones; real targets are a
   * founder decision (density RFI). */
  medianArrivalMinutes: number;
  /** Alert if the share of requests that ever failed to match exceeds this. */
  matchFailureRate: number;
  /** Alert if the share of assignments ending in a no-show exceeds this. */
  noShowRate: number;
  /** Below this many samples, report insufficient_data instead of alerting. */
  minSample: number;
}

export const DEFAULT_THRESHOLDS: ServiceHealthThresholds = {
  medianArrivalMinutes: 30,
  matchFailureRate: 0.1,
  noShowRate: 0.05,
  minSample: 5,
};

export interface ServiceHealth {
  sample: number;
  medianArrivalMinutes: number | null;
  matchFailureRate: number | null;
  noShowRate: number | null;
  escalationCount: number;
  alerts: Array<{ metric: string; observed: number; threshold: number; severity: "warn" | "critical" }>;
  insufficientData: boolean;
}

const countOf = (timelines: EvidenceEvent[][], eventType: string): number =>
  timelines.reduce((sum, t) => sum + t.filter((e) => e.eventType === eventType).length, 0);

export function serviceHealth(
  timelines: EvidenceEvent[][],
  thresholds: ServiceHealthThresholds = DEFAULT_THRESHOLDS
): ServiceHealth {
  const arrivals = timelines
    .map(requestToArrivalMinutes)
    .filter((v): v is number => v !== null);
  const medianArrival = median(arrivals);

  const withFailure = timelines.filter((t) => t.some((e) => e.eventType === "request.match_failed")).length;
  const matchFailureRate = timelines.length > 0 ? withFailure / timelines.length : null;

  const accepted = countOf(timelines, "provider.accepted");
  const noShows = countOf(timelines, "provider.no_show");
  const noShowRate = accepted > 0 ? noShows / accepted : null;

  const health: ServiceHealth = {
    sample: timelines.length,
    medianArrivalMinutes: medianArrival,
    matchFailureRate,
    noShowRate,
    escalationCount: countOf(timelines, "request.escalated"),
    alerts: [],
    insufficientData: timelines.length < thresholds.minSample,
  };
  // Below the sample floor we report numbers but never raise alerts —
  // alerting on three data points is theater, not observability.
  if (health.insufficientData) return health;

  if (medianArrival !== null && medianArrival > thresholds.medianArrivalMinutes) {
    health.alerts.push({
      metric: "median_request_to_arrival_minutes",
      observed: medianArrival,
      threshold: thresholds.medianArrivalMinutes,
      severity: medianArrival > thresholds.medianArrivalMinutes * 1.5 ? "critical" : "warn",
    });
  }
  if (matchFailureRate !== null && matchFailureRate > thresholds.matchFailureRate) {
    health.alerts.push({
      metric: "match_failure_rate",
      observed: matchFailureRate,
      threshold: thresholds.matchFailureRate,
      severity: matchFailureRate > thresholds.matchFailureRate * 2 ? "critical" : "warn",
    });
  }
  if (noShowRate !== null && noShowRate > thresholds.noShowRate) {
    health.alerts.push({
      metric: "no_show_rate",
      observed: noShowRate,
      threshold: thresholds.noShowRate,
      severity: noShowRate > thresholds.noShowRate * 2 ? "critical" : "warn",
    });
  }
  return health;
}
