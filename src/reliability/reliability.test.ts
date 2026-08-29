import { describe, expect, it } from "vitest";
import { DEFAULT_SERVICE_TYPES } from "../common/config.js";
import { InMemoryEvidenceStore } from "../common/evidence/inMemoryStore.js";
import { RequestService } from "../requests/service.js";
import { InMemoryRequestStore } from "../requests/store.js";
import { MatchingEngine } from "../matching/engine.js";
import { MockProviderDirectory } from "../matching/directory.js";
import { DEFAULT_POLICY, ReliabilityService } from "./service.js";
import { serviceHealth, DEFAULT_THRESHOLDS } from "./alerts.js";
import type { AvailableProvider } from "../matching/types.js";

const MEMBER = { type: "member" as const, id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa" };
const SYSTEM = { type: "system" as const, id: "s" };

const provider = (id: string, lat = 34.06): AvailableProvider => ({
  id,
  serviceTypes: ["tow"],
  city: "los-angeles",
  lat,
  lng: -118.25,
  available: true,
});

const t = (minutes: number) => new Date(Date.UTC(2026, 7, 26, 12, minutes));

async function setup(providers: AvailableProvider[]) {
  const evidence = new InMemoryEvidenceStore();
  const requests = new RequestService(evidence, new InMemoryRequestStore(), DEFAULT_SERVICE_TYPES);
  const directory = new MockProviderDirectory(providers.map((p) => ({ ...p })));
  const matching = new MatchingEngine(directory, requests, evidence, { marketplaceEnabled: true });
  const reliability = new ReliabilityService(requests, matching, evidence, DEFAULT_POLICY);
  return { evidence, requests, directory, matching, reliability };
}

async function triagedRequest(requests: RequestService, at = t(0)) {
  const record = await requests.create(
    MEMBER,
    { serviceType: "tow", city: "los-angeles", lat: 34.05, lng: -118.24 },
    `c-${at.getTime()}`,
    at
  );
  await requests.transition(SYSTEM, record.id, "triaged", `t-${at.getTime()}`, at);
  return record;
}

describe("reliability sweep — the request nobody picked up", () => {
  it("SAFETY: a request stuck in `created` is force-triaged — a member is never left unwatched", async () => {
    const { requests, reliability } = await setup([provider("p1")]);
    // Created but never triaged (orchestration crashed, or raced).
    const record = await requests.create(
      MEMBER,
      { serviceType: "tow", city: "los-angeles", lat: 34.05, lng: -118.24 },
      "stuck",
      t(0)
    );
    expect(record.status).toBe("created");
    // Inside the grace window: untouched.
    expect(await reliability.sweep(t(0))).toMatchObject({ stuckCreatedRecovered: 0 });
    // Past it: rescued into the normal pipeline.
    expect(await reliability.sweep(t(1))).toMatchObject({ stuckCreatedRecovered: 1 });
    expect((await requests.get(record.id))?.status).toBe("triaged");
    // And the next sweep matches it like any other request.
    await reliability.sweep(t(3));
    expect(await requests.assignedProvider(record.id)).toBe("p1");
  });

  it("regression: orchestration hangs off onCreated, so the projection always exists when it fires", async () => {
    const evidence = new InMemoryEvidenceStore();
    const store = new InMemoryRequestStore();
    const seen: (string | null)[] = [];
    const service: RequestService = new RequestService(
      evidence,
      store,
      DEFAULT_SERVICE_TYPES,
      undefined,
      (record) => {
        // The bug: an onEvent consumer ran before insert() and saw null here.
        seen.push(record.id);
      }
    );
    const record = await service.create(
      MEMBER,
      { serviceType: "tow", city: "los-angeles", lat: 34.05, lng: -118.24 },
      "onCreated",
      t(0)
    );
    expect(seen).toEqual([record.id]);
    // Projection is readable at the moment the hook fires.
    expect(await store.findById(record.id)).not.toBeNull();
  });
});

describe("reliability sweep — nobody is found", () => {
  it("retries matching until supply appears, then matches", async () => {
    const { requests, directory, reliability } = await setup([]);
    const request = await triagedRequest(requests);

    // Too soon: no retry yet.
    expect(await reliability.sweep(t(0))).toMatchObject({ rematchAttempted: 0 });
    // A minute later: retried, still nothing.
    const first = await reliability.sweep(t(2));
    expect(first).toMatchObject({ rematchAttempted: 1, rematched: 0 });
    // Supply arrives; the next sweep matches it — no member action needed.
    directory.setAvailable("p1", true);
    (directory as unknown as { providers: AvailableProvider[] }).providers.push(provider("p1"));
    const second = await reliability.sweep(t(4));
    expect(second).toMatchObject({ rematched: 1 });
    expect((await requests.get(request.id))?.status).toBe("matched");
  });

  it("escalates to ops after the silence threshold — exactly once", async () => {
    const { requests, evidence, reliability } = await setup([]);
    const request = await triagedRequest(requests);
    await reliability.sweep(t(9)); // past the 8-minute escalation threshold
    const escalate = await reliability.sweep(t(10));
    const escalations = (await evidence.timeline(request.id)).filter(
      (e) => e.eventType === "request.escalated"
    );
    expect(escalations).toHaveLength(1);
    expect(escalations[0]?.payload).toMatchObject({ reason: "no_provider_found" });
    expect(escalate.escalated).toBe(0); // second sweep does not re-escalate
  });
});

describe("reliability sweep — the provider never comes", () => {
  it("recovers a provider who accepts but never starts, and reassigns to a different one", async () => {
    const { requests, evidence, matching, reliability } = await setup([provider("ghost", 34.061), provider("hero", 34.07)]);
    const request = await triagedRequest(requests);
    const match = await matching.match(request.id, "m1", t(1));
    expect(match).toMatchObject({ matched: true, providerId: "ghost" }); // nearest

    // 6 minutes matched, never en_route → no-show recovery.
    const report = await reliability.sweep(t(7));
    expect(report.noShowsRecovered).toBe(1);
    expect((await requests.get(request.id))?.status).toBe("triaged");
    expect(await requests.assignedProvider(request.id)).toBeNull();

    // Next sweep rematches — and must NOT pick the ghost again.
    await reliability.sweep(t(9));
    expect(await requests.assignedProvider(request.id)).toBe("hero");

    const types = (await evidence.timeline(request.id)).map((e) => e.eventType);
    expect(types).toContain("provider.no_show");
    expect(types).toContain("provider.unassigned");
    expect(types.filter((x) => x === "request.matched")).toHaveLength(2); // matched twice
  });

  it("recovers a provider who goes en_route and never arrives", async () => {
    const { requests, evidence, matching, reliability } = await setup([provider("stalled")]);
    const request = await triagedRequest(requests);
    await matching.match(request.id, "m1", t(1));
    await requests.transition({ type: "provider", id: "stalled" }, request.id, "en_route", "er", t(2));

    // Well past the arrival deadline (45 min).
    const report = await reliability.sweep(t(50));
    expect(report.noShowsRecovered).toBe(1);
    expect((await requests.get(request.id))?.status).toBe("triaged");
    const noShow = (await evidence.timeline(request.id)).find((e) => e.eventType === "provider.no_show");
    expect(noShow?.payload).toMatchObject({ providerId: "stalled", reason: "never_arrived" });
  });

  it("adversarial: a healthy in-flight journey is never disturbed, and sweeps are idempotent", async () => {
    const { requests, evidence, matching, reliability } = await setup([provider("good")]);
    const request = await triagedRequest(requests);
    await matching.match(request.id, "m1", t(1));
    await requests.transition({ type: "provider", id: "good" }, request.id, "en_route", "er", t(2));

    // Inside every deadline: sweeps must do nothing at all.
    for (const at of [t(3), t(10), t(30)]) {
      expect(await reliability.sweep(at)).toMatchObject({ noShowsRecovered: 0, rematchAttempted: 0, escalated: 0 });
    }
    await requests.transition({ type: "provider", id: "good" }, request.id, "on_scene", "os", t(20));
    await requests.transition({ type: "provider", id: "good" }, request.id, "resolved", "rs", t(35));
    // Terminal requests are out of scope entirely.
    expect(await reliability.sweep(t(200))).toMatchObject({ examined: 0 });

    const types = (await evidence.timeline(request.id)).map((e) => e.eventType);
    expect(types).not.toContain("provider.no_show");
    expect(types).not.toContain("request.escalated");
  });

  it("double-sweeping the same no-show does not double-emit or double-recover", async () => {
    const { requests, evidence, matching, reliability } = await setup([provider("ghost"), provider("hero", 34.07)]);
    const request = await triagedRequest(requests);
    await matching.match(request.id, "m1", t(1));
    const first = await reliability.sweep(t(7));
    const second = await reliability.sweep(t(7)); // same instant, repeated
    expect(first.noShowsRecovered).toBe(1);
    expect(second.noShowsRecovered).toBe(0);
    expect((await evidence.timeline(request.id)).filter((e) => e.eventType === "provider.no_show")).toHaveLength(1);
  });
});

describe("service health alerts", () => {
  const arrival = (minutes: number) =>
    [
      { eventType: "request.created", occurredAt: t(0) },
      { eventType: "request.on_scene", occurredAt: t(minutes) },
    ] as any[];

  it("stays silent below the sample floor, even when numbers look bad", () => {
    const health = serviceHealth([arrival(90), arrival(120)]);
    expect(health.insufficientData).toBe(true);
    expect(health.alerts).toHaveLength(0);
    expect(health.medianArrivalMinutes).toBe(105); // still reported
  });

  it("raises a critical alert when median arrival blows past target", () => {
    const health = serviceHealth([arrival(50), arrival(60), arrival(70), arrival(80), arrival(90)]);
    expect(health.medianArrivalMinutes).toBe(70);
    expect(health.alerts).toMatchObject([
      { metric: "median_request_to_arrival_minutes", severity: "critical", threshold: 30 },
    ]);
  });

  it("is quiet when service is good", () => {
    const health = serviceHealth([arrival(12), arrival(15), arrival(18), arrival(20), arrival(22)]);
    expect(health.alerts).toHaveLength(0);
    expect(health.medianArrivalMinutes).toBe(18);
  });

  it("flags no-show and match-failure rates from stored events", () => {
    const withNoShow = [
      ...arrival(20),
      { eventType: "provider.accepted", occurredAt: t(1) },
      { eventType: "provider.no_show", occurredAt: t(6) },
      { eventType: "request.match_failed", occurredAt: t(2) },
    ] as any[];
    const clean = [...arrival(20), { eventType: "provider.accepted", occurredAt: t(1) }] as any[];
    const health = serviceHealth([withNoShow, clean, clean, clean, clean], DEFAULT_THRESHOLDS);
    expect(health.noShowRate).toBe(0.2);
    expect(health.matchFailureRate).toBe(0.2);
    expect(health.alerts.map((a) => a.metric).sort()).toEqual(["match_failure_rate", "no_show_rate"]);
  });
});
