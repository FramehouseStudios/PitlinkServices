// PHASE 0 EXIT CRITERION, EXECUTABLE:
// "An end-to-end request can be created, matched (mock or live), tracked,
//  and closed with stored evidence events that produce a reproducible
//  timeline."
// This test chains the real domain services — no shortcuts through stores —
// and then reproduces the timeline AND a first metric purely from the spine.
import { describe, expect, it } from "vitest";
import { DEFAULT_SERVICE_TYPES } from "./common/config.js";
import { InMemoryEvidenceStore } from "./common/evidence/inMemoryStore.js";
import { RequestService } from "./requests/service.js";
import { InMemoryRequestStore } from "./requests/store.js";
import { MockProviderDirectory } from "./matching/directory.js";
import { MatchingEngine } from "./matching/engine.js";
import { TrackingService } from "./realtime/tracking.js";
import { fleetMetrics } from "./common/metrics/calculations.js";
import { reconcileRequest } from "./common/metrics/reconcile.js";

const MEMBER = { type: "member" as const, id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa" };

describe("PHASE 0 EXIT CRITERION", () => {
  it("full journey: created → triaged → matched → en_route → on_scene → resolved → closed, reproducible from the spine", async () => {
    const evidence = new InMemoryEvidenceStore();
    const requests = new RequestService(evidence, new InMemoryRequestStore(), DEFAULT_SERVICE_TYPES);
    const engine = new MatchingEngine(
      new MockProviderDirectory([
        {
          id: "provider-1",
          serviceTypes: ["tow"],
          city: "los-angeles",
          lat: 34.06,
          lng: -118.25,
          available: true,
        },
      ]),
      requests,
      evidence,
      { marketplaceEnabled: true }
    );

    const t = (minutes: number) => new Date(Date.UTC(2026, 7, 26, 10, minutes));

    // The journey, driven only through the public domain surface.
    const request = await requests.create(
      MEMBER,
      { serviceType: "tow", city: "los-angeles", lat: 34.05, lng: -118.24 },
      "exit-create",
      t(0)
    );
    await requests.transition({ type: "system", id: "triage-agent" }, request.id, "triaged", "e1", t(1));
    const match = await engine.match(request.id, "exit-match", t(3));
    expect(match.matched).toBe(true);
    const providerId = (match as { providerId: string }).providerId;
    const provider = { type: "provider" as const, id: providerId };
    await requests.transition(provider, request.id, "en_route", "e2", t(5));
    // Tracked: a live location ping with reproducible ETA inputs.
    const tracking = new TrackingService(evidence, requests);
    const ping = await tracking.providerPing(providerId, request.id, 34.058, -118.245, t(10));
    expect(ping.recorded).toBe(true);
    await requests.transition(provider, request.id, "on_scene", "e3", t(18));  // arrival
    await requests.transition(provider, request.id, "resolved", "e4", t(40));
    await requests.transition({ type: "ops", id: "reconciler" }, request.id, "closed", "e5", t(45));

    // 1. The timeline is complete, ordered, and fully attributed.
    const timeline = await evidence.timeline(request.id);
    expect(timeline.map((e) => e.eventType)).toEqual([
      "request.created",
      "request.triaged",
      "provider.offered",
      "provider.accepted",
      "request.matched",
      "request.en_route",
      "request.location_update",
      "request.on_scene",
      "request.resolved",
      "request.closed",
    ]);
    for (const event of timeline) {
      expect(event.actorType).toBeTruthy();
      expect(event.actorId).toBeTruthy();
      expect(event.calculationRulesVersion).toBeTruthy();
    }

    // 2. The North Star metrics come from the VERSIONED calculation rules
    //    over stored events alone — no other source.
    const report = fleetMetrics([timeline]);
    expect(report.medianRequestToArrivalMinutes).toBe(18);
    expect(report.remoteResolutionRate).toBe(0);
    expect(report.rulesVersion).toBeTruthy();

    // 3. Reconciliation: the projection agrees with the spine.
    const projection = await requests.get(request.id);
    expect(reconcileRequest(timeline, projection)).toEqual({ consistent: true, status: "closed" });
  });
});
