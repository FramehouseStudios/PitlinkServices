import { describe, expect, it } from "vitest";
import { DEFAULT_SERVICE_TYPES } from "../common/config.js";
import { InMemoryEvidenceStore } from "../common/evidence/inMemoryStore.js";
import { RequestService } from "../requests/service.js";
import { InMemoryRequestStore } from "../requests/store.js";
import { MatchingEngine } from "../matching/engine.js";
import { InMemoryProviderPresence } from "./presence.js";
import { PresenceProviderDirectory } from "./directory.js";
import { RequestEventBus } from "./bus.js";

const MEMBER = { type: "member" as const, id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa" };
const BEAT = {
  providerId: "provider-1",
  serviceTypes: ["tow"],
  city: "los-angeles",
  lat: 34.06,
  lng: -118.25,
  available: true,
};

describe("provider presence", () => {
  it("heartbeats appear as candidates and expire on TTL", async () => {
    let now = 1_000_000;
    const presence = new InMemoryProviderPresence(() => now);
    await presence.heartbeat(BEAT, 30);
    expect(await presence.candidates("tow", "los-angeles")).toHaveLength(1);
    // Wrong service / wrong city / unavailable are invisible.
    expect(await presence.candidates("lockout", "los-angeles")).toHaveLength(0);
    expect(await presence.candidates("tow", "san-diego")).toHaveLength(0);
    await presence.heartbeat({ ...BEAT, available: false }, 30);
    expect(await presence.candidates("tow", "los-angeles")).toHaveLength(0);
    // Back available, then silence past TTL — supply ages out.
    await presence.heartbeat(BEAT, 30);
    now += 31_000;
    expect(await presence.candidates("tow", "los-angeles")).toHaveLength(0);
  });

  it("drives the matching engine live: offline → match_failed, heartbeat → matched", async () => {
    let now = 1_000_000;
    const presence = new InMemoryProviderPresence(() => now);
    const evidence = new InMemoryEvidenceStore();
    const requests = new RequestService(evidence, new InMemoryRequestStore(), DEFAULT_SERVICE_TYPES);
    const engine = new MatchingEngine(new PresenceProviderDirectory(presence), requests, evidence, {
      marketplaceEnabled: true,
    });
    const request = await requests.create(
      MEMBER,
      { serviceType: "tow", city: "los-angeles", lat: 34.05, lng: -118.24 },
      "c1"
    );
    await requests.transition({ type: "system", id: "t" }, request.id, "triaged", "t1");

    expect(await engine.match(request.id, "a1")).toEqual({ matched: false, reason: "no_providers" });
    await presence.heartbeat(BEAT, 30);
    expect(await engine.match(request.id, "a2")).toMatchObject({ matched: true, providerId: "provider-1" });
  });
});

describe("request event bus", () => {
  it("delivers new events to subscribers of that request only, and unsubscribes cleanly", async () => {
    const bus = new RequestEventBus();
    const seenA: string[] = [];
    const seenB: string[] = [];
    const requests = new RequestService(
      new InMemoryEvidenceStore(),
      new InMemoryRequestStore(),
      DEFAULT_SERVICE_TYPES,
      (e) => bus.publish(e)
    );
    const a = await requests.create(MEMBER, { serviceType: "tow", city: "la", lat: 1, lng: 1 }, "a");
    const b = await requests.create(MEMBER, { serviceType: "tow", city: "la", lat: 1, lng: 1 }, "b");
    const offA = bus.subscribe(a.id, (e) => seenA.push(e.eventType));
    bus.subscribe(b.id, (e) => seenB.push(e.eventType));

    await requests.transition(MEMBER, a.id, "cancelled", "t1");
    expect(seenA).toEqual(["request.cancelled"]);
    expect(seenB).toEqual([]);

    offA();
    await requests.transition(MEMBER, b.id, "cancelled", "t2");
    expect(seenA).toEqual(["request.cancelled"]);
    expect(seenB).toEqual(["request.cancelled"]);
  });

  it("failure mode: replayed transitions do not re-publish; broken subscribers do not break others", async () => {
    const bus = new RequestEventBus();
    const seen: string[] = [];
    const requests = new RequestService(
      new InMemoryEvidenceStore(),
      new InMemoryRequestStore(),
      DEFAULT_SERVICE_TYPES,
      (e) => bus.publish(e)
    );
    const request = await requests.create(MEMBER, { serviceType: "tow", city: "la", lat: 1, lng: 1 }, "c");
    bus.subscribe(request.id, () => {
      throw new Error("broken subscriber");
    });
    bus.subscribe(request.id, (e) => seen.push(e.eventType));
    await requests.transition(MEMBER, request.id, "cancelled", "t1");
    await requests.transition(MEMBER, request.id, "cancelled", "t1"); // replay
    expect(seen).toEqual(["request.cancelled"]);
  });
});
