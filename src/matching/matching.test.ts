import { describe, expect, it } from "vitest";
import { DEFAULT_SERVICE_TYPES } from "../common/config.js";
import { InMemoryEvidenceStore } from "../common/evidence/inMemoryStore.js";
import { RequestService } from "../requests/service.js";
import { InMemoryRequestStore } from "../requests/store.js";
import { MockProviderDirectory } from "./directory.js";
import { MatchingEngine } from "./engine.js";
import type { AvailableProvider } from "./types.js";

const MEMBER = { type: "member" as const, id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa" };
const SYSTEM = { type: "system" as const, id: "test" };

// Downtown LA request; one provider in Echo Park (~3km), one in Santa Monica (~20km).
const NEAR: AvailableProvider = {
  id: "provider-near",
  serviceTypes: ["jump_start", "tow"],
  city: "los-angeles",
  lat: 34.078,
  lng: -118.26,
  available: true,
};
const FAR: AvailableProvider = {
  id: "provider-far",
  serviceTypes: ["jump_start", "tow", "lockout"],
  city: "los-angeles",
  lat: 34.019,
  lng: -118.49,
  available: true,
};

async function setup(providers: AvailableProvider[], marketplaceEnabled = true) {
  const evidence = new InMemoryEvidenceStore();
  const requests = new RequestService(evidence, new InMemoryRequestStore(), DEFAULT_SERVICE_TYPES);
  const directory = new MockProviderDirectory(providers.map((p) => ({ ...p })));
  const engine = new MatchingEngine(directory, requests, evidence, { marketplaceEnabled });
  const request = await requests.create(
    MEMBER,
    { serviceType: "jump_start", city: "los-angeles", lat: 34.05, lng: -118.24 },
    "create-1"
  );
  await requests.transition(SYSTEM, request.id, "triaged", "t1");
  return { evidence, requests, directory, engine, request };
}

describe("matching engine", () => {
  it("matches a triaged request to the nearest capable provider with full evidence", async () => {
    const { engine, requests, evidence, request } = await setup([FAR, NEAR]);
    const outcome = await engine.match(request.id, "attempt-1");
    expect(outcome).toMatchObject({ matched: true, providerId: "provider-near" });
    expect((outcome as { distanceKm: number }).distanceKm).toBeLessThan(5);
    expect((await requests.get(request.id))?.status).toBe("matched");

    const timeline = await evidence.timeline(request.id);
    expect(timeline.map((e) => e.eventType)).toEqual([
      "request.created",
      "request.triaged",
      "provider.offered",
      "provider.accepted",
      "request.matched",
    ]);
    // Attribution: offer by the system, acceptance by the provider principal.
    expect(timeline.find((e) => e.eventType === "provider.offered")?.actorType).toBe("system");
    const accepted = timeline.find((e) => e.eventType === "provider.accepted");
    expect(accepted?.actorType).toBe("provider");
    expect(accepted?.actorId).toBe("provider-near");
  });

  it("filters by service type and availability", async () => {
    const lockoutOnly: AvailableProvider = { ...NEAR, id: "lockout-only", serviceTypes: ["lockout"] };
    const { engine, directory, request } = await setup([lockoutOnly, FAR]);
    // FAR can jump-start; lockout-only cannot despite being nearer.
    const outcome = await engine.match(request.id, "attempt-1");
    expect(outcome).toMatchObject({ matched: true, providerId: "provider-far" });
    void directory;
  });

  it("failure mode: no capable providers → match_failed on the spine, request stays triaged", async () => {
    const { engine, requests, evidence, request, directory } = await setup([NEAR]);
    directory.setAvailable("provider-near", false);
    const outcome = await engine.match(request.id, "attempt-1");
    expect(outcome).toEqual({ matched: false, reason: "no_providers" });
    expect((await requests.get(request.id))?.status).toBe("triaged");
    const failures = (await evidence.timeline(request.id)).filter((e) => e.eventType === "request.match_failed");
    expect(failures).toHaveLength(1);
    expect(failures[0]?.payload).toMatchObject({ reason: "no_providers", city: "los-angeles" });
    // Recovery: provider comes back, a NEW attempt succeeds.
    directory.setAvailable("provider-near", true);
    expect(await engine.match(request.id, "attempt-2")).toMatchObject({ matched: true });
  });

  it("bounded evidence: repeated retries record ONE match failure per episode, not one per attempt", async () => {
    const { engine, evidence, request, directory, requests } = await setup([NEAR]);
    directory.setAvailable("provider-near", false);
    // Ten retry attempts against empty supply, as the sweep would do.
    for (let i = 0; i < 10; i++) {
      expect(await engine.match(request.id, `retry-${i}`)).toEqual({ matched: false, reason: "no_providers" });
    }
    const failures = (await evidence.timeline(request.id)).filter((e) => e.eventType === "request.match_failed");
    expect(failures).toHaveLength(1);

    // Supply returns and the request matches: the episode closes.
    directory.setAvailable("provider-near", true);
    expect(await engine.match(request.id, "recover")).toMatchObject({ matched: true });
    // A LATER failure (after recovery sent it back to triaged) is
    // newsworthy again — this is a new episode, not retry noise.
    await requests.transition(SYSTEM, request.id, "triaged", "back-to-triaged");
    directory.setAvailable("provider-near", false);
    await engine.match(request.id, "retry-later");
    const after = (await evidence.timeline(request.id)).filter((e) => e.eventType === "request.match_failed");
    expect(after).toHaveLength(2);
  });

  it("failure mode: marketplace flag off → clean refusal, nothing on the spine", async () => {
    const { engine, evidence, request } = await setup([NEAR], false);
    const outcome = await engine.match(request.id, "attempt-1");
    expect(outcome).toEqual({ matched: false, reason: "marketplace_disabled" });
    expect((await evidence.timeline(request.id)).map((e) => e.eventType)).toEqual([
      "request.created",
      "request.triaged",
    ]);
  });

  it("adversarial: refuses requests that are not triaged — no stray offer evidence", async () => {
    const { engine, requests, evidence } = await setup([NEAR]);
    const fresh = await requests.create(
      MEMBER,
      { serviceType: "tow", city: "los-angeles", lat: 34.05, lng: -118.24 },
      "create-fresh"
    );
    expect(await engine.match(fresh.id, "a1")).toEqual({ matched: false, reason: "request_not_triaged" });
    expect(await engine.match("00000000-0000-4000-8000-000000000000", "a2")).toEqual({
      matched: false,
      reason: "request_not_triaged",
    });
    expect((await evidence.timeline(fresh.id)).map((e) => e.eventType)).toEqual(["request.created"]);
  });

  it("idempotency: replaying an attempt key emits no duplicate events", async () => {
    const { engine, evidence, request } = await setup([NEAR]);
    const first = await engine.match(request.id, "attempt-1");
    const replay = await engine.match(request.id, "attempt-1");
    // Second call sees status 'matched' and refuses before any emission.
    expect(first).toMatchObject({ matched: true });
    expect(replay).toEqual({ matched: false, reason: "request_not_triaged" });
    const timeline = await evidence.timeline(request.id);
    expect(timeline.filter((e) => e.eventType === "provider.offered")).toHaveLength(1);
    expect(timeline.filter((e) => e.eventType === "provider.accepted")).toHaveLength(1);
  });
});
