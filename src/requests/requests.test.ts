import { describe, expect, it } from "vitest";
import { InMemoryEvidenceStore } from "../common/evidence/inMemoryStore.js";
import { DEFAULT_SERVICE_TYPES } from "../common/config.js";
import { RequestService, type Actor } from "./service.js";
import { InMemoryRequestStore } from "./store.js";
import { IllegalTransitionError, RequestValidationError } from "./types.js";

const MEMBER: Actor = { type: "member", id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa" };
const OTHER_MEMBER: Actor = { type: "member", id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb" };
const SYSTEM: Actor = { type: "system", id: "matching-engine" };
const PROVIDER: Actor = { type: "provider", id: "cccccccc-cccc-4ccc-8ccc-cccccccccccc" };

const INPUT = { serviceType: "jump_start", city: "los-angeles", lat: 34.05, lng: -118.24 };

function setup() {
  const evidence = new InMemoryEvidenceStore();
  const service = new RequestService(evidence, new InMemoryRequestStore(), DEFAULT_SERVICE_TYPES);
  return { evidence, service };
}

describe("request lifecycle", () => {
  it("runs the full physical journey and reproduces the timeline from the spine", async () => {
    const { service } = setup();
    const request = await service.create(MEMBER, INPUT, "create-1");
    await service.transition(SYSTEM, request.id, "triaged", "t1");
    await service.transition(SYSTEM, request.id, "matched", "t2");
    await service.transition(PROVIDER, request.id, "en_route", "t3");
    await service.transition(PROVIDER, request.id, "on_scene", "t4");
    await service.transition(PROVIDER, request.id, "resolved", "t5");
    const closed = await service.transition(SYSTEM, request.id, "closed", "t6");
    expect(closed.status).toBe("closed");

    const timeline = await service.timeline(request.id);
    expect(timeline.map((e) => e.eventType)).toEqual([
      "request.created",
      "request.triaged",
      "request.matched",
      "request.en_route",
      "request.on_scene",
      "request.resolved",
      "request.closed",
    ]);
    // Every event is versioned and attributed — reproducibility requirements.
    for (const e of timeline) {
      expect(e.calculationRulesVersion).toBeTruthy();
      expect(e.actorId).toBeTruthy();
    }
  });

  it("supports the remote/software-first close: triaged → resolved with no dispatch", async () => {
    const { service } = setup();
    const request = await service.create(MEMBER, INPUT, "create-remote");
    await service.transition(SYSTEM, request.id, "triaged", "t1");
    const resolved = await service.transition(SYSTEM, request.id, "resolved", "t2");
    expect(resolved.status).toBe("resolved");
    const timeline = await service.timeline(request.id);
    expect(timeline.map((e) => e.eventType)).toEqual([
      "request.created",
      "request.triaged",
      "request.resolved",
    ]);
  });

  it("create is idempotent: same key returns the same request, one creation event", async () => {
    const { service, evidence } = setup();
    const first = await service.create(MEMBER, INPUT, "same-key");
    const replay = await service.create(MEMBER, { ...INPUT, city: "tampered" }, "same-key");
    expect(replay.id).toBe(first.id);
    expect(replay.city).toBe("los-angeles");
    expect(await evidence.timeline(first.id)).toHaveLength(1);
  });

  it("transitions are idempotent under key replay", async () => {
    const { service } = setup();
    const request = await service.create(MEMBER, INPUT, "c1");
    await service.transition(SYSTEM, request.id, "triaged", "t1");
    const replay = await service.transition(SYSTEM, request.id, "triaged", "t1");
    expect(replay.status).toBe("triaged");
    expect((await service.timeline(request.id)).filter((e) => e.eventType === "request.triaged")).toHaveLength(1);
  });

  it("failure mode: rejects unknown service types, bad coordinates, empty city", async () => {
    const { service } = setup();
    await expect(service.create(MEMBER, { ...INPUT, serviceType: "helicopter" }, "k")).rejects.toThrow(RequestValidationError);
    await expect(service.create(MEMBER, { ...INPUT, lat: 91 }, "k")).rejects.toThrow(RequestValidationError);
    await expect(service.create(MEMBER, { ...INPUT, city: " " }, "k")).rejects.toThrow(RequestValidationError);
  });

  it("adversarial: illegal jumps and wrong populations are denied AND audited on the spine", async () => {
    const { service } = setup();
    const request = await service.create(MEMBER, INPUT, "c1");

    // created → resolved skips the machine.
    await expect(service.transition(SYSTEM, request.id, "resolved", "x1")).rejects.toThrow(IllegalTransitionError);
    // A member cannot declare themselves matched.
    await service.transition(SYSTEM, request.id, "triaged", "t1");
    await expect(service.transition(MEMBER, request.id, "matched", "x2")).rejects.toThrow(/wrong_actor_population/);
    // A provider cannot triage.
    const req2 = await service.create(MEMBER, INPUT, "c2");
    await expect(service.transition(PROVIDER, req2.id, "triaged", "x3")).rejects.toThrow(/wrong_actor_population/);
    // Another member cannot cancel someone else's request.
    await expect(service.transition(OTHER_MEMBER, request.id, "cancelled", "x4")).rejects.toThrow(/wrong_actor_population/);
    // The owning member can.
    const cancelled = await service.transition(MEMBER, request.id, "cancelled", "t2");
    expect(cancelled.status).toBe("cancelled");

    const denials = (await service.timeline(request.id)).filter((e) => e.eventType === "request.transition_denied");
    expect(denials.length).toBe(3);
    expect(denials.map((d) => (d.payload as { reason: string }).reason)).toEqual([
      "illegal_transition",
      "wrong_actor_population",
      "wrong_actor_population",
    ]);
  });

  it("regression: the same client key on two different requests does not collide", async () => {
    const { service } = setup();
    const a = await service.create(MEMBER, INPUT, "c-a");
    const b = await service.create(MEMBER, INPUT, "c-b");
    await service.transition(MEMBER, a.id, "cancelled", "shared-key");
    const cancelled = await service.transition(MEMBER, b.id, "cancelled", "shared-key");
    expect(cancelled.status).toBe("cancelled");
    expect((await service.get(b.id))?.status).toBe("cancelled");
  });

  it("failure mode: terminal states accept nothing", async () => {
    const { service } = setup();
    const request = await service.create(MEMBER, INPUT, "c1");
    await service.transition(MEMBER, request.id, "cancelled", "t1");
    await expect(service.transition(SYSTEM, request.id, "triaged", "t2")).rejects.toThrow(IllegalTransitionError);
  });

  it("heals a missing projection row from the creation event on idempotent replay", async () => {
    const evidence = new InMemoryEvidenceStore();
    const brokenStore = new InMemoryRequestStore();
    const service = new RequestService(evidence, brokenStore, DEFAULT_SERVICE_TYPES);
    const first = await service.create(MEMBER, INPUT, "heal-key");
    // Simulate crash-after-evidence-before-insert by wiping the projection.
    (brokenStore as unknown as { byId: Map<string, unknown> }).byId.delete(first.id);
    const healed = await service.create(MEMBER, INPUT, "heal-key");
    expect(healed.id).toBe(first.id);
    expect(healed.status).toBe("created");
  });
});
