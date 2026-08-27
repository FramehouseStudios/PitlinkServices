import { describe, expect, it } from "vitest";
import { DEFAULT_SERVICE_TYPES } from "../config.js";
import { InMemoryEvidenceStore } from "../evidence/inMemoryStore.js";
import { RequestService } from "../../requests/service.js";
import { InMemoryRequestStore } from "../../requests/store.js";
import {
  fleetMetrics,
  isRemoteResolution,
  median,
  paidCentsByCurrency,
  providerRatings,
  requestToArrivalMinutes,
} from "./calculations.js";
import { deriveStatus, reconcileRequest } from "./reconcile.js";
import type { EvidenceEvent } from "../evidence/types.js";

const MEMBER = { type: "member" as const, id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa" };
const SYSTEM = { type: "system" as const, id: "s" };
const PROVIDER = { type: "provider" as const, id: "cccccccc-cccc-4ccc-8ccc-cccccccccccc" };

const t = (minutes: number) => new Date(Date.UTC(2026, 7, 26, 12, minutes));

/** Build a real timeline by driving the domain services. */
async function journey(kind: "dispatched" | "remote" | "open", minutesToArrival = 20) {
  const evidence = new InMemoryEvidenceStore();
  const requests = new RequestService(evidence, new InMemoryRequestStore(), DEFAULT_SERVICE_TYPES);
  const record = await requests.create(
    MEMBER,
    { serviceType: "tow", city: "los-angeles", lat: 34.05, lng: -118.24 },
    "c",
    t(0)
  );
  await requests.transition(SYSTEM, record.id, "triaged", "t1", t(1));
  if (kind === "remote") {
    await requests.transition(SYSTEM, record.id, "resolved", "t2", t(9));
  } else if (kind === "dispatched") {
    await evidence.append({
      requestId: record.id,
      eventType: "provider.accepted",
      payload: { providerId: PROVIDER.id },
      actorType: "provider",
      actorId: PROVIDER.id,
      calculationRulesVersion: "test",
      idempotencyKey: `assign:${record.id}`,
      occurredAt: t(2),
    });
    await requests.transition(SYSTEM, record.id, "matched", "t2", t(3));
    await requests.transition(PROVIDER, record.id, "en_route", "t3", t(5));
    await requests.transition(PROVIDER, record.id, "on_scene", "t4", t(minutesToArrival));
    await requests.transition(PROVIDER, record.id, "resolved", "t5", t(minutesToArrival + 15));
  }
  return { timeline: await evidence.timeline(record.id), record, requests, evidence };
}

describe("metric calculations", () => {
  it("derives arrival, resolution, match times and remoteness from real timelines", async () => {
    const dispatched = await journey("dispatched", 20);
    expect(requestToArrivalMinutes(dispatched.timeline)).toBe(20);
    expect(isRemoteResolution(dispatched.timeline)).toBe(false);

    const remote = await journey("remote");
    expect(requestToArrivalMinutes(remote.timeline)).toBeNull();
    expect(isRemoteResolution(remote.timeline)).toBe(true);

    const open = await journey("open");
    expect(requestToArrivalMinutes(open.timeline)).toBeNull();
    expect(isRemoteResolution(open.timeline)).toBeNull(); // not resolved: excluded, not counted
  });

  it("fleet report: medians, remote-resolution rate, match failures", async () => {
    const timelines = [
      (await journey("dispatched", 14)).timeline,
      (await journey("dispatched", 22)).timeline,
      (await journey("dispatched", 30)).timeline,
      (await journey("remote")).timeline,
      (await journey("open")).timeline,
    ];
    const report = fleetMetrics(timelines);
    expect(report.requestCount).toBe(5);
    expect(report.medianRequestToArrivalMinutes).toBe(22);
    expect(report.remoteResolutionRate).toBe(0.25); // 1 remote of 4 resolved
    expect(report.matchFailureCount).toBe(0);
    expect(report.rulesVersion).toBeTruthy();
  });

  it("provider ratings aggregate from feedback events across timelines", async () => {
    const a = await journey("dispatched", 14);
    await a.requests.feedback(MEMBER, a.record.id, 5, "great");
    const b = await journey("dispatched", 30);
    await b.requests.feedback(MEMBER, b.record.id, 3);
    const c = await journey("remote"); // no provider — feedback carries no providerId
    await c.requests.feedback(MEMBER, c.record.id, 4);
    const ratings = providerRatings([
      await a.evidence.timeline(a.record.id),
      await b.evidence.timeline(b.record.id),
      await c.evidence.timeline(c.record.id),
    ]);
    expect(ratings[PROVIDER.id]).toEqual({ count: 2, avgRating: 4 });
    expect(Object.keys(ratings)).toHaveLength(1);
  });

  it("median: odd, even, empty", () => {
    expect(median([3, 1, 2])).toBe(2);
    expect(median([4, 1, 3, 2])).toBe(2.5);
    expect(median([])).toBeNull();
  });

  it("sums successful payments by currency, ignoring failures", () => {
    const base = { requestId: "r", actorType: "system" as const, actorId: "p", calculationRulesVersion: "v", occurredAt: t(0), recordedAt: t(0) };
    const events: EvidenceEvent[] = [
      { ...base, id: 1, eventType: "payment.succeeded", payload: { amountCents: 4200, currency: "usd" }, idempotencyKey: "a" },
      { ...base, id: 2, eventType: "payment.failed", payload: { amountCents: 9900, currency: "usd" }, idempotencyKey: "b" },
      { ...base, id: 3, eventType: "payment.succeeded", payload: { amountCents: 1000, currency: "usd" }, idempotencyKey: "c" },
    ];
    expect(paidCentsByCurrency(events)).toEqual({ usd: 5200 });
  });
});

describe("reconciliation", () => {
  it("consistent projection passes; spine status derives from the last lifecycle event", async () => {
    const { timeline, requests, record } = await journey("dispatched");
    expect(deriveStatus(timeline)).toBe("resolved");
    const projection = await requests.get(record.id);
    expect(reconcileRequest(timeline, projection)).toEqual({ consistent: true, status: "resolved" });
  });

  it("failure modes: drifted and missing projections are reported, never repaired", async () => {
    const { timeline, record } = await journey("dispatched");
    const drifted = { ...record, status: "created" as const };
    expect(reconcileRequest(timeline, drifted)).toMatchObject({
      consistent: false,
      discrepancy: "status_drift",
      spineStatus: "resolved",
      projectionStatus: "created",
    });
    expect(reconcileRequest(timeline, null)).toMatchObject({
      consistent: false,
      discrepancy: "missing_projection",
    });
    expect(reconcileRequest([], record)).toMatchObject({
      consistent: false,
      discrepancy: "no_lifecycle_events",
    });
  });
});
