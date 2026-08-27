// Live supply for the matching engine: the same ProviderDirectory interface
// the mock implemented, now sourced from presence heartbeats. The engine does
// not know the difference — that was the point of the interface.
import type { ProviderDirectory, AvailableProvider } from "../matching/types.js";
import type { ProviderPresence } from "./presence.js";

export class PresenceProviderDirectory implements ProviderDirectory {
  constructor(private readonly presence: ProviderPresence) {}

  async findCandidates(serviceType: string, city: string): Promise<AvailableProvider[]> {
    return this.presence.candidates(serviceType, city);
  }
}
