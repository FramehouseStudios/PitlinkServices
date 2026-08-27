// Matching bounded context. Phase 0 works against a mock provider pool;
// Phase 1's live providers drop in behind the same interfaces.

export interface AvailableProvider {
  id: string;
  /** Service types this provider can perform (subset of the catalog). */
  serviceTypes: string[];
  city: string;
  lat: number;
  lng: number;
  available: boolean;
}

export interface ProviderDirectory {
  /** Providers able to serve this service type in this city, right now. */
  findCandidates(serviceType: string, city: string): Promise<AvailableProvider[]>;
}

export type MatchOutcome =
  | { matched: true; providerId: string; distanceKm: number }
  | { matched: false; reason: "marketplace_disabled" | "request_not_triaged" | "no_providers" };
