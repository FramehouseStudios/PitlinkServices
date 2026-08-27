// Provider reputation from the evidence spine. Two rules shape this design:
//
// 1. A provider's livelihood is at stake, so suppression requires a MINIMUM
//    SAMPLE — one bad night must never cost someone their work, and thin
//    supply is fatal to members. When in doubt, keep the provider.
// 2. Reputation is derived, never stored as an opinion: every number here is
//    recomputable from stored events, like any other material metric.
import type { EvidenceEvent } from "../common/evidence/types.js";
import type { RequestService } from "../requests/service.js";

export interface ProviderReputation {
  providerId: string;
  accepted: number;
  noShows: number;
  completed: number;
  noShowRate: number;
  ratingCount: number;
  avgRating: number | null;
  suppressed: boolean;
  /** Why this provider is suppressed, for ops and for the provider. */
  suppressionReasons: string[];
}

export interface ReputationPolicy {
  /** Minimum accepted jobs before a no-show rate can suppress. ESTIMATE. */
  minAssignments: number;
  /** No-show rate above this suppresses. ESTIMATE — founder/ops decision. */
  maxNoShowRate: number;
  /** Minimum ratings before an average can suppress. ESTIMATE. */
  minRatings: number;
  /** Average rating below this suppresses. ESTIMATE. */
  minAvgRating: number;
}

export const DEFAULT_REPUTATION_POLICY: ReputationPolicy = {
  minAssignments: 5,
  maxNoShowRate: 0.3,
  minRatings: 3,
  minAvgRating: 2.5,
};

/** Pure: fold timelines into per-provider reputation under a policy. */
export function computeReputations(
  timelines: EvidenceEvent[][],
  policy: ReputationPolicy = DEFAULT_REPUTATION_POLICY
): Map<string, ProviderReputation> {
  const stats = new Map<string, { accepted: number; noShows: number; completed: number; ratingTotal: number; ratingCount: number }>();
  const of = (id: string) => {
    let entry = stats.get(id);
    if (!entry) {
      entry = { accepted: 0, noShows: 0, completed: 0, ratingTotal: 0, ratingCount: 0 };
      stats.set(id, entry);
    }
    return entry;
  };

  for (const timeline of timelines) {
    for (const event of timeline) {
      const payload = event.payload as { providerId?: string; rating?: number };
      const providerId = payload.providerId;
      if (!providerId) continue;
      if (event.eventType === "provider.accepted") of(providerId).accepted++;
      else if (event.eventType === "provider.no_show") of(providerId).noShows++;
      else if (event.eventType === "request.feedback" && typeof payload.rating === "number") {
        const entry = of(providerId);
        entry.ratingTotal += payload.rating;
        entry.ratingCount++;
      }
    }
    // A resolved request credits its assigned provider with a completion.
    const resolved = timeline.some((e) => e.eventType === "request.resolved");
    if (resolved) {
      const assigned = assignedFrom(timeline);
      if (assigned) of(assigned).completed++;
    }
  }

  const result = new Map<string, ProviderReputation>();
  for (const [providerId, entry] of stats) {
    const noShowRate = entry.accepted > 0 ? entry.noShows / entry.accepted : 0;
    const avgRating = entry.ratingCount > 0 ? entry.ratingTotal / entry.ratingCount : null;
    const suppressionReasons: string[] = [];
    if (entry.accepted >= policy.minAssignments && noShowRate > policy.maxNoShowRate) {
      suppressionReasons.push(`no_show_rate ${noShowRate.toFixed(2)} > ${policy.maxNoShowRate}`);
    }
    if (entry.ratingCount >= policy.minRatings && avgRating !== null && avgRating < policy.minAvgRating) {
      suppressionReasons.push(`avg_rating ${avgRating.toFixed(2)} < ${policy.minAvgRating}`);
    }
    result.set(providerId, {
      providerId,
      accepted: entry.accepted,
      noShows: entry.noShows,
      completed: entry.completed,
      noShowRate,
      ratingCount: entry.ratingCount,
      avgRating,
      suppressed: suppressionReasons.length > 0,
      suppressionReasons,
    });
  }
  return result;
}

/** Assigned provider per a single timeline (unassign clears an accept). */
function assignedFrom(timeline: EvidenceEvent[]): string | null {
  for (let i = timeline.length - 1; i >= 0; i--) {
    const event = timeline[i]!;
    if (event.eventType === "provider.unassigned") return null;
    if (event.eventType === "provider.accepted") {
      return (event.payload as { providerId?: string }).providerId ?? event.actorId;
    }
  }
  return null;
}

/**
 * Keeps a cached reputation snapshot so matching stays a fast, synchronous
 * decision. Stale-by-at-most-ttl is the right trade: reputation changes on
 * the scale of jobs, not milliseconds.
 */
export class ReputationService {
  private snapshot = new Map<string, ProviderReputation>();
  private refreshedAtMs = 0;

  constructor(
    private readonly requests: RequestService,
    private readonly policy: ReputationPolicy = DEFAULT_REPUTATION_POLICY,
    private readonly windowSize = 500,
    private readonly ttlMs = 60_000
  ) {}

  async refresh(now: Date = new Date()): Promise<Map<string, ProviderReputation>> {
    const recent = await this.requests.listRecent(this.windowSize);
    const timelines = await Promise.all(recent.map((r) => this.requests.timeline(r.id)));
    this.snapshot = computeReputations(timelines, this.policy);
    this.refreshedAtMs = now.getTime();
    return this.snapshot;
  }

  async refreshIfStale(now: Date = new Date()): Promise<void> {
    if (now.getTime() - this.refreshedAtMs >= this.ttlMs) await this.refresh(now);
  }

  /** Synchronous read for the matching hot path. */
  isSuppressed(providerId: string): boolean {
    return this.snapshot.get(providerId)?.suppressed ?? false;
  }

  list(): ProviderReputation[] {
    return [...this.snapshot.values()].sort((a, b) => b.noShowRate - a.noShowRate);
  }
}
