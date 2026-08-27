import { describe, expect, it } from "vitest";
import { DEFAULT_SERVICE_TYPES } from "../common/config.js";
import { InMemoryEvidenceStore } from "../common/evidence/inMemoryStore.js";
import { RequestService } from "../requests/service.js";
import { InMemoryRequestStore } from "../requests/store.js";
import { MatchingEngine } from "../matching/engine.js";
import { MockProviderDirectory } from "../matching/directory.js";
import { TrackingService } from "./tracking.js";

const MEMBER = { type: "member" as const, id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa" };
const SYSTEM = { type: "system" as const, id: "s" };
const PROVIDER_ID = "provider-1";

const t = (seconds: number) => new Date(Date.UTC(2026, 7, 26, 12, 0, seconds));

async function setup() {
  const evidence = new InMemoryEvidenceStore();
  const requests = new RequestService(evidence, new InMemoryRequestStore(), DEFAULT_SERVICE_TYPES);
  const engine = new MatchingEngine(
    new MockProviderDirectory([
      { id: PROVIDER_ID, serviceTypes: ["tow"], city: "los-angeles", lat: 34.1, lng: -118.3, available: true },
    ]),
    requests,
    evidence,
    { marketplaceEnabled: true }
  );
  const tracking = new TrackingService(evidence, requests, { minPingIntervalSeconds: 15, assumedSpeedKmh: 30 });
  const request = await requests.create(
    MEMBER,
    { serviceType: "tow", city: "los-angeles", lat: 34.05, lng: -118.24 },
    "c",
    t(0)
  );
  await requests.transition(SYSTEM, request.id, "triaged", "t1", t(1));
  await engine.match(request.id, "m1", t(2));
  return { evidence, requests, tracking, request };
}

describe("tracking service", () => {
  it("records pings en_route with reproducible ETA inputs; throttles chatty clients", async () => {
    const { evidence, requests, tracking, request } = await setup();
    await requests.transition({ type: "provider", id: PROVIDER_ID }, request.id, "en_route", "t2", t(3));

    const ping = await tracking.providerPing(PROVIDER_ID, request.id, 34.09, -118.29, t(10));
    expect(ping.recorded).toBe(true);
    const { distanceKm, etaMinutes } = ping as { distanceKm: number; etaMinutes: number };
    expect(distanceKm).toBeGreaterThan(0);
    expect(etaMinutes).toBeCloseTo((distanceKm / 30) * 60, 0);

    // 5 seconds later: throttled, nothing on the spine.
    expect(await tracking.providerPing(PROVIDER_ID, request.id, 34.08, -118.28, t(15))).toEqual({
      recorded: false,
      reason: "throttled",
    });
    // 20 seconds later: recorded.
    expect((await tracking.providerPing(PROVIDER_ID, request.id, 34.07, -118.27, t(30))).recorded).toBe(true);

    const updates = (await evidence.timeline(request.id)).filter((e) => e.eventType === "request.location_update");
    expect(updates).toHaveLength(2);
    expect(updates[0]!.payload).toMatchObject({
      providerId: PROVIDER_ID,
      etaBasis: { method: "straight_line", assumedSpeedKmh: 30 },
    });
    expect(updates[0]!.actorType).toBe("provider");
  });

  it("adversarial: only the assigned provider, only en_route, only sane coordinates", async () => {
    const { evidence, requests, tracking, request } = await setup();
    // Not yet en_route (status: matched).
    expect(await tracking.providerPing(PROVIDER_ID, request.id, 34.09, -118.29, t(5))).toEqual({
      recorded: false,
      reason: "request_not_en_route",
    });
    await requests.transition({ type: "provider", id: PROVIDER_ID }, request.id, "en_route", "t2", t(6));
    // A different provider cannot inject locations.
    expect(await tracking.providerPing("provider-imposter", request.id, 34.09, -118.29, t(10))).toEqual({
      recorded: false,
      reason: "not_assigned_provider",
    });
    // Garbage coordinates rejected.
    expect(await tracking.providerPing(PROVIDER_ID, request.id, 91, -118.29, t(12))).toEqual({
      recorded: false,
      reason: "invalid_coordinates",
    });
    // After arrival, pings stop being accepted.
    await requests.transition({ type: "provider", id: PROVIDER_ID }, request.id, "on_scene", "t3", t(20));
    expect(await tracking.providerPing(PROVIDER_ID, request.id, 34.05, -118.24, t(40))).toEqual({
      recorded: false,
      reason: "request_not_en_route",
    });
    // Denied pings left nothing on the spine.
    const updates = (await evidence.timeline(request.id)).filter((e) => e.eventType === "request.location_update");
    expect(updates).toHaveLength(0);
  });
});
