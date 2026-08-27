// SERVICE RELIABILITY LAYER — the difference between "we dispatched someone"
// and world-class service. Legacy roadside fails in exactly three ways:
// nobody is found, someone accepts and never arrives, and nobody tells the
// member. This sweep closes all three, on the evidence spine, so every
// recovery is measurable and auditable.
//
// Blueprint §9 explicitly requires these controls: matching timeout,
// provider no-show, and automated alerts on median-time regression.
import type { EvidenceStore } from "../common/evidence/store.js";
import type { EvidenceEvent } from "../common/evidence/types.js";
import { CALCULATION_RULES_VERSION } from "../common/evidence/rules.js";
import type { MatchingEngine } from "../matching/engine.js";
import type { RequestService } from "../requests/service.js";
import type { RequestRecord } from "../requests/types.js";

export interface ReliabilityPolicy {
  /** Retry matching an unmatched request this often. ESTIMATE default 60s. */
  rematchIntervalSeconds: number;
  /** Escalate to ops after this long unmatched. ESTIMATE default 8 min. */
  unmatchedEscalationSeconds: number;
  /** A matched provider must be en_route within this long. ESTIMATE 5 min. */
  acceptToEnRouteSeconds: number;
  /** An en_route provider must arrive within this long. ESTIMATE 45 min. */
  enRouteToArrivalSeconds: number;
  /** Requests examined per sweep. */
  batchSize: number;
}

export const DEFAULT_POLICY: ReliabilityPolicy = {
  rematchIntervalSeconds: 60,
  unmatchedEscalationSeconds: 480,
  acceptToEnRouteSeconds: 300,
  enRouteToArrivalSeconds: 2700,
  batchSize: 100,
};

export interface SweepReport {
  examined: number;
  rematchAttempted: number;
  rematched: number;
  noShowsRecovered: number;
  escalated: number;
}

export class ReliabilityService {
  constructor(
    private readonly requests: RequestService,
    private readonly matching: MatchingEngine,
    private readonly evidence: EvidenceStore,
    private readonly policy: ReliabilityPolicy = DEFAULT_POLICY,
    private readonly onEvent?: (event: EvidenceEvent) => void
  ) {}

  /**
   * One reliability pass over in-flight requests. Idempotent per interval
   * bucket: sweeping twice inside the same interval does not double-emit.
   */
  async sweep(now: Date = new Date()): Promise<SweepReport> {
    const report: SweepReport = {
      examined: 0,
      rematchAttempted: 0,
      rematched: 0,
      noShowsRecovered: 0,
      escalated: 0,
    };
    const inFlight = await this.requests.listByStatus(
      ["triaged", "matched", "en_route"],
      this.policy.batchSize
    );
    report.examined = inFlight.length;

    for (const request of inFlight) {
      const waited = (now.getTime() - request.updatedAt.getTime()) / 1000;
      if (request.status === "triaged") {
        await this.handleUnmatched(request, waited, now, report);
      } else if (request.status === "matched") {
        if (waited >= this.policy.acceptToEnRouteSeconds) {
          await this.recoverNoShow(request, "never_started", now, report);
        }
      } else if (request.status === "en_route") {
        if (waited >= this.policy.enRouteToArrivalSeconds) {
          await this.recoverNoShow(request, "never_arrived", now, report);
        }
      }
    }
    return report;
  }

  private async handleUnmatched(
    request: RequestRecord,
    waitedSeconds: number,
    now: Date,
    report: SweepReport
  ): Promise<void> {
    if (waitedSeconds < this.policy.rematchIntervalSeconds) return;

    // Bucketed key: at most one retry per interval, however often we sweep.
    const bucket = Math.floor(waitedSeconds / this.policy.rematchIntervalSeconds);
    report.rematchAttempted++;
    const outcome = await this.matching.match(request.id, `retry:${bucket}`, now);
    if (outcome.matched) {
      report.rematched++;
      return;
    }
    // Still nothing. Past the escalation threshold, tell ops once — silence
    // is the failure mode we refuse to ship.
    if (waitedSeconds >= this.policy.unmatchedEscalationSeconds) {
      const escalated = await this.emit(request.id, "request.escalated", {
        reason: "no_provider_found",
        waitedSeconds: Math.round(waitedSeconds),
        serviceType: request.serviceType,
        city: request.city,
      }, `escalate:${request.id}:no_provider`, now);
      if (escalated) report.escalated++;
    }
  }

  /**
   * A provider accepted and then stalled. Record the no-show, unassign them
   * (excluding them from future offers on this request), and return the
   * request to triaged so the next sweep rematches it.
   */
  private async recoverNoShow(
    request: RequestRecord,
    reason: "never_started" | "never_arrived",
    now: Date,
    report: SweepReport
  ): Promise<void> {
    const providerId = await this.requests.assignedProvider(request.id);
    if (!providerId) return; // nothing to recover from

    const key = `noshow:${request.id}:${providerId}:${reason}`;
    const recorded = await this.emit(
      request.id,
      "provider.no_show",
      { providerId, reason, fromStatus: request.status },
      key,
      now
    );
    if (!recorded) return; // already handled

    await this.emit(request.id, "provider.unassigned", { providerId, reason }, `unassign:${key}`, now);
    // Back to triaged: the matching engine skips previously-tried providers.
    await this.requests.transition(
      { type: "system", id: "reliability" },
      request.id,
      "triaged",
      `noshow-recover:${key}`,
      now
    );
    report.noShowsRecovered++;
  }

  /** Append an event; returns false if this key was already recorded. */
  private async emit(
    requestId: string,
    eventType: string,
    payload: Record<string, unknown>,
    idempotencyKey: string,
    now: Date
  ): Promise<boolean> {
    const before = await this.evidence.timeline(requestId);
    const already = before.some((e) => e.idempotencyKey === idempotencyKey);
    if (already) return false;
    const event = await this.evidence.append({
      requestId,
      eventType,
      payload,
      actorType: "system",
      actorId: "reliability",
      calculationRulesVersion: CALCULATION_RULES_VERSION,
      idempotencyKey,
      occurredAt: now,
    });
    this.onEvent?.(event);
    return true;
  }
}
