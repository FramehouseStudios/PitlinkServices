// Live tracking during dispatch. Location pings land on the spine as
// request.location_update with the ETA derivation inputs INCLUDED in the
// payload — any historical ETA is recomputable from the stored event alone.
// Only the assigned provider may ping, only while en_route, and pings are
// throttled so a chatty client cannot flood the spine.
import { haversineKm } from "../common/geo.js";
import type { EvidenceStore } from "../common/evidence/store.js";
import type { EvidenceEvent } from "../common/evidence/types.js";
import { CALCULATION_RULES_VERSION } from "../common/evidence/rules.js";
import type { RequestService } from "../requests/service.js";

export interface TrackingOptions {
  /** Minimum seconds between recorded pings per request. ESTIMATE default. */
  minPingIntervalSeconds?: number;
  /** Assumed average city driving speed for the ETA heuristic. ESTIMATE:
   * straight-line distance at this speed; replaced by a maps adapter when
   * routing is worth paying for. */
  assumedSpeedKmh?: number;
}

export type PingResult =
  | { recorded: true; distanceKm: number; etaMinutes: number }
  | { recorded: false; reason: "request_not_en_route" | "not_assigned_provider" | "throttled" | "invalid_coordinates" };

export class TrackingService {
  private readonly minIntervalMs: number;
  private readonly speedKmh: number;
  private lastPingAt = new Map<string, number>();

  constructor(
    private readonly evidence: EvidenceStore,
    private readonly requests: RequestService,
    options: TrackingOptions = {},
    private readonly onEvent?: (event: EvidenceEvent) => void
  ) {
    this.minIntervalMs = (options.minPingIntervalSeconds ?? 15) * 1000;
    this.speedKmh = options.assumedSpeedKmh ?? 30;
  }

  async providerPing(
    providerId: string,
    requestId: string,
    lat: number,
    lng: number,
    now: Date = new Date()
  ): Promise<PingResult> {
    if (!Number.isFinite(lat) || lat < -90 || lat > 90 || !Number.isFinite(lng) || lng < -180 || lng > 180) {
      return { recorded: false, reason: "invalid_coordinates" };
    }
    const request = await this.requests.get(requestId);
    if (!request) return { recorded: false, reason: "not_assigned_provider" };
    // Assignment BEFORE status: an unassigned provider learns nothing about
    // this request's state. The spine is the source of truth for assignment.
    const assigned = await this.requests.assignedProvider(requestId);
    if (assigned !== providerId) return { recorded: false, reason: "not_assigned_provider" };
    if (request.status !== "en_route") return { recorded: false, reason: "request_not_en_route" };

    const last = this.lastPingAt.get(requestId);
    if (last !== undefined && now.getTime() - last < this.minIntervalMs) {
      return { recorded: false, reason: "throttled" };
    }

    const distanceKm = haversineKm(lat, lng, request.lat, request.lng);
    const etaMinutes = Math.round((distanceKm / this.speedKmh) * 60 * 10) / 10;

    const event = await this.evidence.append({
      requestId,
      eventType: "request.location_update",
      payload: {
        providerId,
        lat,
        lng,
        distanceKm,
        etaMinutes,
        // ETA derivation inputs — reproducibility requirement.
        etaBasis: { method: "straight_line", assumedSpeedKmh: this.speedKmh },
      },
      actorType: "provider",
      actorId: providerId,
      calculationRulesVersion: CALCULATION_RULES_VERSION,
      idempotencyKey: `track:${requestId}:${now.getTime()}`,
      occurredAt: now,
    });
    this.lastPingAt.set(requestId, now.getTime());
    this.onEvent?.(event);
    return { recorded: true, distanceKm, etaMinutes };
  }

}
