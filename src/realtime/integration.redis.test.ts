// Integration tests against real Redis. Skipped unless REDIS_URL is set
// (docker compose up -d). Verifies what the in-memory mirror cannot: real
// TTL expiry and the city-index cleanup path.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { RedisProviderPresence } from "./presence.js";

const REDIS_URL = process.env.REDIS_URL;

describe.skipIf(!REDIS_URL)("redis presence integration", () => {
  let presence: RedisProviderPresence;
  const city = `it-city-${randomUUID()}`; // isolated per run

  beforeAll(async () => {
    presence = await RedisProviderPresence.connect(REDIS_URL!);
  });

  afterAll(async () => {
    await presence.close();
  });

  it("heartbeat → candidate; TTL expiry removes it and cleans the index", async () => {
    const providerId = `it-${randomUUID()}`;
    await presence.heartbeat(
      { providerId, serviceTypes: ["tow"], city, lat: 34, lng: -118, available: true },
      1
    );
    expect(await presence.candidates("tow", city)).toMatchObject([{ id: providerId }]);
    expect(await presence.candidates("lockout", city)).toHaveLength(0);

    await new Promise((r) => setTimeout(r, 1200));
    expect(await presence.candidates("tow", city)).toHaveLength(0);
    // Second read after cleanup is also empty (index entry removed).
    expect(await presence.candidates("tow", city)).toHaveLength(0);
  });

  it("renewal keeps a provider present past the original TTL", async () => {
    const providerId = `it-${randomUUID()}`;
    const beat = { providerId, serviceTypes: ["tow"], city, lat: 34, lng: -118, available: true };
    await presence.heartbeat(beat, 1);
    await new Promise((r) => setTimeout(r, 600));
    await presence.heartbeat(beat, 1); // renew before expiry
    await new Promise((r) => setTimeout(r, 600));
    expect(await presence.candidates("tow", city)).toMatchObject([{ id: providerId }]);
  });
});
