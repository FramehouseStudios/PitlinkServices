// Provider presence: heartbeats with TTL. A provider that stops heartbeating
// simply disappears from supply — no stale "available" flags. Redis is the
// live implementation (EXPIRE does the aging); the in-memory one mirrors its
// semantics for tests and offline development.
import { createClient } from "redis";
import type { AvailableProvider } from "../matching/types.js";

export interface Heartbeat {
  providerId: string;
  serviceTypes: string[];
  city: string;
  lat: number;
  lng: number;
  available: boolean;
}

export interface ProviderPresence {
  /** Record a heartbeat; the entry expires ttlSeconds later unless renewed. */
  heartbeat(beat: Heartbeat, ttlSeconds: number): Promise<void>;
  /** Providers currently present, available, and capable in this city. */
  candidates(serviceType: string, city: string): Promise<AvailableProvider[]>;
}

export class InMemoryProviderPresence implements ProviderPresence {
  private entries = new Map<string, { beat: Heartbeat; expiresAt: number }>();

  constructor(private readonly clock: () => number = Date.now) {}

  async heartbeat(beat: Heartbeat, ttlSeconds: number): Promise<void> {
    this.entries.set(beat.providerId, {
      beat: { ...beat, serviceTypes: [...beat.serviceTypes] },
      expiresAt: this.clock() + ttlSeconds * 1000,
    });
  }

  async candidates(serviceType: string, city: string): Promise<AvailableProvider[]> {
    const now = this.clock();
    const result: AvailableProvider[] = [];
    for (const [id, entry] of this.entries) {
      if (entry.expiresAt <= now) {
        this.entries.delete(id);
        continue;
      }
      const { beat } = entry;
      if (beat.available && beat.city === city && beat.serviceTypes.includes(serviceType)) {
        result.push({ id: beat.providerId, serviceTypes: [...beat.serviceTypes], city: beat.city, lat: beat.lat, lng: beat.lng, available: true });
      }
    }
    return result;
  }
}

type RedisClient = ReturnType<typeof createClient>;

const KEY_PREFIX = "presence:provider:";
const CITY_INDEX = "presence:city:";

export class RedisProviderPresence implements ProviderPresence {
  constructor(private readonly client: RedisClient) {}

  static async connect(redisUrl: string): Promise<RedisProviderPresence> {
    const client = createClient({ url: redisUrl });
    await client.connect();
    // The library's generic instantiation differs from the default-parameter
    // ReturnType; the command surface we use is identical.
    return new RedisProviderPresence(client as unknown as RedisClient);
  }

  async heartbeat(beat: Heartbeat, ttlSeconds: number): Promise<void> {
    const key = `${KEY_PREFIX}${beat.providerId}`;
    await this.client
      .multi()
      .set(key, JSON.stringify(beat), { EX: ttlSeconds })
      .sAdd(`${CITY_INDEX}${beat.city}`, beat.providerId)
      .exec();
  }

  async candidates(serviceType: string, city: string): Promise<AvailableProvider[]> {
    const ids = await this.client.sMembers(`${CITY_INDEX}${city}`);
    if (ids.length === 0) return [];
    const values = await this.client.mGet(ids.map((id) => `${KEY_PREFIX}${id}`));
    const result: AvailableProvider[] = [];
    const stale: string[] = [];
    ids.forEach((id, i) => {
      const raw = values[i];
      if (!raw) {
        stale.push(id); // TTL expired — clean the index opportunistically
        return;
      }
      const beat = JSON.parse(raw) as Heartbeat;
      if (beat.available && beat.city === city && beat.serviceTypes.includes(serviceType)) {
        result.push({ id: beat.providerId, serviceTypes: beat.serviceTypes, city: beat.city, lat: beat.lat, lng: beat.lng, available: true });
      }
    });
    if (stale.length > 0) await this.client.sRem(`${CITY_INDEX}${city}`, stale);
    return result;
  }

  async close(): Promise<void> {
    await this.client.quit();
  }
}
