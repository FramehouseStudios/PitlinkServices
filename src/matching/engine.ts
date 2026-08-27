// Matching engine: triaged request → provider assignment. Every step lands
// on the evidence spine BEFORE the request state changes, so median
// request→match time and match-failure rates are reproducible from stored
// events — the exact numbers the business is judged on.
import { haversineKm } from "../common/geo.js";
import type { EvidenceStore } from "../common/evidence/store.js";
import { CALCULATION_RULES_VERSION } from "../common/evidence/rules.js";
import type { RequestService } from "../requests/service.js";
import type { MatchOutcome, ProviderDirectory } from "./types.js";

import type { EvidenceEvent } from "../common/evidence/types.js";

export interface MatchingEngineOptions {
  /** From config ENABLE_PROVIDER_MARKETPLACE — never hard-coded. */
  marketplaceEnabled: boolean;
  /** Notified after each new spine event — realtime push. */
  onEvent?: (event: EvidenceEvent) => void;
  /**
   * Quality gate: providers the spine shows to be unreliable. Consulted as a
   * PREFERENCE, not an absolute ban — see match(): if suppressing would
   * leave a member with nobody, we send the suppressed provider anyway and
   * record that we did. A late truck beats no truck.
   */
  isSuppressed?: (providerId: string) => boolean;
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

    // Providers already tried on this request (no-shows, prior assignments)
    // are never offered it again — a member must not wait on the same truck
    // twice.
    const excluded = await this.previouslyTried(requestId);
    const available = (await this.directory.findCandidates(request.serviceType, request.city)).filter(
      (p) => !excluded.has(p.id)
    );
    // Quality gate, applied as a preference: prefer providers in good
    // standing, but never leave a member stranded to enforce it.
    const suppressed = this.options.isSuppressed;
    const preferred = suppressed ? available.filter((p) => !suppressed(p.id)) : available;
    const usedFallback = preferred.length === 0 && available.length > 0;
    const candidates = usedFallback ? available : preferred;
    if (candidates.length === 0) {
      // Match failure is metric-affecting (density risk is THE business
      // risk) — it must be measurable, so it goes on the spine.
      const failed = await this.evidence.append({
        requestId,
        eventType: "request.match_failed",
        payload: { serviceType: request.serviceType, city: request.city, reason: "no_providers" },
        actorType: "system",
        actorId: "matching-engine",
        calculationRulesVersion: CALCULATION_RULES_VERSION,
        idempotencyKey: `match.failed:${requestId}:${attemptKey}`,
        occurredAt: now,
      });
      this.options.onEvent?.(failed);
      return { matched: false, reason: "no_providers" };
    }

    const ranked = candidates
      .map((p) => ({ provider: p, distanceKm: haversineKm(request.lat, request.lng, p.lat, p.lng) }))
      .sort((a, b) => a.distanceKm - b.distanceKm);
    const best = ranked[0]!;

    const offered = await this.evidence.append({
      requestId,
      eventType: "provider.offered",
      payload: {
        providerId: best.provider.id,
        distanceKm: best.distanceKm,
        // Quality-gate outcome is recorded so both the decision and its
        // override are measurable from the spine.
        ...(suppressed ? { qualitySuppressedCount: available.length - preferred.length } : {}),
        ...(usedFallback ? { qualityFallback: true } : {}),
      },
      actorType: "system",
      actorId: "matching-engine",
      calculationRulesVersion: CALCULATION_RULES_VERSION,
      idempotencyKey: `match.offered:${requestId}:${attemptKey}`,
      occurredAt: now,
    });
    this.options.onEvent?.(offered);
    // Phase 0 mock: auto-accept. Phase 1 replaces this with the provider's
    // real response behind the same event.
    const accepted = await this.evidence.append({
      requestId,
      eventType: "provider.accepted",
      payload: { providerId: best.provider.id },
      actorType: "provider",
      actorId: best.provider.id,
      calculationRulesVersion: CALCULATION_RULES_VERSION,
      idempotencyKey: `match.accepted:${requestId}:${attemptKey}`,
      occurredAt: now,
    });
    this.options.onEvent?.(accepted);
    await this.requests.transition(
      { type: "system", id: "matching-engine" },
      requestId,
      "matched",
      `match:${attemptKey}`,
      now
    );

    return { matched: true, providerId: best.provider.id, distanceKm: best.distanceKm };
  }

  /** Provider ids already offered/assigned on this request, per the spine. */
  private async previouslyTried(requestId: string): Promise<Set<string>> {
    const timeline = await this.evidence.timeline(requestId);
    const tried = new Set<string>();
    for (const event of timeline) {
      if (event.eventType === "provider.offered" || event.eventType === "provider.accepted") {
        const id = (event.payload as { providerId?: string }).providerId;
        if (id) tried.add(id);
      }
    }
    return tried;
  }
}
