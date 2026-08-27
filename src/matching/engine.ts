// Matching engine: triaged request → provider assignment. Every step lands
// on the evidence spine BEFORE the request state changes, so median
// request→match time and match-failure rates are reproducible from stored
// events — the exact numbers the business is judged on.
import { haversineKm } from "../common/geo.js";
import type { EvidenceStore } from "../common/evidence/store.js";
import { CALCULATION_RULES_VERSION } from "../common/evidence/rules.js";
import type { RequestService } from "../requests/service.js";
import type { MatchOutcome, ProviderDirectory } from "./types.js";

export interface MatchingEngineOptions {
  /** From config ENABLE_PROVIDER_MARKETPLACE — never hard-coded. */
  marketplaceEnabled: boolean;
}

export class MatchingEngine {
  constructor(
    private readonly directory: ProviderDirectory,
    private readonly requests: RequestService,
    private readonly evidence: EvidenceStore,
    private readonly options: MatchingEngineOptions
  ) {}

  /**
   * Attempt to match one triaged request. Idempotent per attemptKey: a
   * replayed attempt emits nothing new. In Phase 0 the mock provider
   * auto-accepts; the offer/accept pair is still recorded separately so the
   * live flow (real accept/decline latency) lands behind the same events.
   */
  async match(requestId: string, attemptKey: string, now: Date = new Date()): Promise<MatchOutcome> {
    if (!this.options.marketplaceEnabled) return { matched: false, reason: "marketplace_disabled" };

    const request = await this.requests.get(requestId);
    if (!request || request.status !== "triaged") {
      return { matched: false, reason: "request_not_triaged" };
    }

    const candidates = await this.directory.findCandidates(request.serviceType, request.city);
    if (candidates.length === 0) {
      // Match failure is metric-affecting (density risk is THE business
      // risk) — it must be measurable, so it goes on the spine.
      await this.evidence.append({
        requestId,
        eventType: "request.match_failed",
        payload: { serviceType: request.serviceType, city: request.city, reason: "no_providers" },
        actorType: "system",
        actorId: "matching-engine",
        calculationRulesVersion: CALCULATION_RULES_VERSION,
        idempotencyKey: `match.failed:${requestId}:${attemptKey}`,
        occurredAt: now,
      });
      return { matched: false, reason: "no_providers" };
    }

    const ranked = candidates
      .map((p) => ({ provider: p, distanceKm: haversineKm(request.lat, request.lng, p.lat, p.lng) }))
      .sort((a, b) => a.distanceKm - b.distanceKm);
    const best = ranked[0]!;

    await this.evidence.append({
      requestId,
      eventType: "provider.offered",
      payload: { providerId: best.provider.id, distanceKm: best.distanceKm },
      actorType: "system",
      actorId: "matching-engine",
      calculationRulesVersion: CALCULATION_RULES_VERSION,
      idempotencyKey: `match.offered:${requestId}:${attemptKey}`,
      occurredAt: now,
    });
    // Phase 0 mock: auto-accept. Phase 1 replaces this with the provider's
    // real response behind the same event.
    await this.evidence.append({
      requestId,
      eventType: "provider.accepted",
      payload: { providerId: best.provider.id },
      actorType: "provider",
      actorId: best.provider.id,
      calculationRulesVersion: CALCULATION_RULES_VERSION,
      idempotencyKey: `match.accepted:${requestId}:${attemptKey}`,
      occurredAt: now,
    });
    await this.requests.transition(
      { type: "system", id: "matching-engine" },
      requestId,
      "matched",
      `match:${attemptKey}`,
      now
    );

    return { matched: true, providerId: best.provider.id, distanceKm: best.distanceKm };
  }
}
