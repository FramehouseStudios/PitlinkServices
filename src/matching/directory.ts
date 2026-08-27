import type { AvailableProvider, ProviderDirectory } from "./types.js";

// Phase 0 mock pool. Seed data is explicitly MOCK — it exists so the matching
// path and its evidence are provable before live providers exist. It carries
// no commercial meaning and must never leak into customer-facing claims.
export class MockProviderDirectory implements ProviderDirectory {
  constructor(private readonly providers: AvailableProvider[]) {}

  async findCandidates(serviceType: string, city: string): Promise<AvailableProvider[]> {
    return this.providers.filter(
      (p) => p.available && p.city === city && p.serviceTypes.includes(serviceType)
    );
  }

  /** Test/dev helper: flip availability. */
  setAvailable(id: string, available: boolean): void {
    const provider = this.providers.find((p) => p.id === id);
    if (provider) provider.available = available;
  }
}
