import { describe, expect, it } from "vitest";
import { DEFAULT_SERVICE_TYPES } from "../common/config.js";
import { InMemoryEvidenceStore } from "../common/evidence/inMemoryStore.js";
import { RequestService } from "../requests/service.js";
import { InMemoryRequestStore } from "../requests/store.js";
import { MatchingEngine } from "../matching/engine.js";
import { MockProviderDirectory } from "../matching/directory.js";
import { computeReputations, DEFAULT_REPUTATION_POLICY, ReputationService } from "./reputation.js";
import type { EvidenceEvent } from "../common/evidence/types.js";
import type { AvailableProvider } from "../matching/types.js";

const MEMBER = { type: "member" as const, id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa" };
const t = (m: number) => new Date(Date.UTC(2026, 7, 26, 12, m));

/** Synthesize a timeline: accepted by provider, optionally no-show/rated. */
function timeline(providerId: string, opts: { noShow?: boolean; rating?: number; resolved?: boolean } = {}): EvidenceEvent[] {
  const base = { requestId: "r", actorType: "system" as const, actorId: "x", calculationRulesVersion: "v", recordedAt: t(0) };
  const events: EvidenceEvent[] = [
    { ...base, id: 1, eventType: "provider.accepted", payload: { providerId }, idempotencyKey: `a${Math.random()}`, occurredAt: t(1) },
  ];
  if (opts.noShow) {
    events.push({ ...base, id: 2, eventType: "provider.no_show", payload: { providerId }, idempotencyKey: `n${Math.random()}`, occurredAt: t(6) });
    events.push({ ...base, id: 3, eventType: "provider.unassigned", payload: { providerId }, idempotencyKey: `u${Math.random()}`, occurredAt: t(6) });
  }
  if (opts.resolved) {
    events.push({ ...base, id: 4, eventType: "request.resolved", payload: {}, idempotencyKey: `r${Math.random()}`, occurredAt: t(30) });
  }
  if (opts.rating !== undefined) {
    events.push({ ...base, id: 5, eventType: "request.feedback", payload: { providerId, rating: opts.rating }, idempotencyKey: `f${Math.random()}`, occurredAt: t(40) });
  }
  return events;
}

describe("provider reputation", () => {
  it("computes no-show rate, completions, and average rating from the spine", () => {
    const reps = computeReputations([
      timeline("p1", { resolved: true, rating: 5 }),
      timeline("p1", { resolved: true, rating: 4 }),
      timeline("p1", { noShow: true }),
    ]);
    const p1 = reps.get("p1")!;
    expect(p1).toMatchObject({ accepted: 3, noShows: 1, completed: 2, ratingCount: 2 });
    expect(p1.noShowRate).toBeCloseTo(1 / 3);
    expect(p1.avgRating).toBe(4.5);
  });

  it("SAFETY: never suppresses below the minimum sample — one bad night cannot cost a provider their work", () => {
    // 100% no-show rate, but only 2 assignments: below minAssignments (5).
    const reps = computeReputations([timeline("new", { noShow: true }), timeline("new", { noShow: true })]);
    expect(reps.get("new")!.noShowRate).toBe(1);
    expect(reps.get("new")!.suppressed).toBe(false);
    // Same for ratings: two 1-star reviews is below minRatings (3).
    const rated = computeReputations([timeline("r1", { resolved: true, rating: 1 }), timeline("r1", { resolved: true, rating: 1 })]);
    expect(rated.get("r1")!.suppressed).toBe(false);
  });

  it("suppresses a chronic no-show once the sample is real, naming the reason", () => {
    const timelines = [
      ...Array.from({ length: 4 }, () => timeline("bad", { noShow: true })),
      ...Array.from({ length: 2 }, () => timeline("bad", { resolved: true })),
    ];
    const bad = computeReputations(timelines).get("bad")!;
    expect(bad.accepted).toBe(6);
    expect(bad.noShowRate).toBeCloseTo(4 / 6);
    expect(bad.suppressed).toBe(true);
    expect(bad.suppressionReasons[0]).toMatch(/no_show_rate/);
  });

  it("suppresses on sustained poor ratings, and leaves good providers alone", () => {
    const poor = computeReputations([
      timeline("meh", { resolved: true, rating: 2 }),
      timeline("meh", { resolved: true, rating: 2 }),
      timeline("meh", { resolved: true, rating: 1 }),
    ]).get("meh")!;
    expect(poor.suppressed).toBe(true);
    expect(poor.suppressionReasons[0]).toMatch(/avg_rating/);

    const good = computeReputations([
      timeline("star", { resolved: true, rating: 5 }),
      timeline("star", { resolved: true, rating: 4 }),
      timeline("star", { resolved: true, rating: 5 }),
      timeline("star", { resolved: true, rating: 5 }),
      timeline("star", { resolved: true, rating: 4 }),
    ]).get("star")!;
    expect(good.suppressed).toBe(false);
    expect(good.completed).toBe(5);
  });
});

const provider = (id: string, lat: number): AvailableProvider => ({
  id, serviceTypes: ["tow"], city: "los-angeles", lat, lng: -118.24, available: true,
});

async function matchWith(providers: AvailableProvider[], suppressedIds: string[]) {
  const evidence = new InMemoryEvidenceStore();
  const requests = new RequestService(evidence, new InMemoryRequestStore(), DEFAULT_SERVICE_TYPES);
  const engine = new MatchingEngine(new MockProviderDirectory(providers), requests, evidence, {
    marketplaceEnabled: true,
    isSuppressed: (id) => suppressedIds.includes(id),
  });
  const record = await requests.create(MEMBER, { serviceType: "tow", city: "los-angeles", lat: 34.05, lng: -118.24 }, "c", t(0));
  await requests.transition({ type: "system", id: "s" }, record.id, "triaged", "t", t(1));
  const outcome = await engine.match(record.id, "m1", t(2));
  return { outcome, timeline: await evidence.timeline(record.id) };
}

describe("quality gating in matching", () => {
  it("skips a suppressed provider in favor of a good one, even if the bad one is nearer", async () => {
    const { outcome, timeline } = await matchWith(
      [provider("bad", 34.0501), provider("good", 34.09)],
      ["bad"]
    );
    expect(outcome).toMatchObject({ matched: true, providerId: "good" });
    const offered = timeline.find((e) => e.eventType === "provider.offered")!;
    expect(offered.payload).toMatchObject({ qualitySuppressedCount: 1 });
    expect(offered.payload).not.toHaveProperty("qualityFallback");
  });

  it("SAFETY: a late truck beats no truck — sends a suppressed provider rather than strand a member, and records it", async () => {
    const { outcome, timeline } = await matchWith([provider("bad", 34.0501)], ["bad"]);
    expect(outcome).toMatchObject({ matched: true, providerId: "bad" });
    const offered = timeline.find((e) => e.eventType === "provider.offered")!;
    expect(offered.payload).toMatchObject({ qualityFallback: true });
    // The override is measurable — ops can see when the gate was bypassed.
    expect(timeline.some((e) => e.eventType === "request.match_failed")).toBe(false);
  });

  it("with no gate configured, matching behaves exactly as before", async () => {
    const { outcome, timeline } = await matchWith([provider("bad", 34.0501), provider("good", 34.09)], []);
    expect(outcome).toMatchObject({ matched: true, providerId: "bad" }); // nearest wins
    const offered = timeline.find((e) => e.eventType === "provider.offered")!;
    expect(offered.payload).toMatchObject({ qualitySuppressedCount: 0 });
  });
});

describe("reputation service caching", () => {
  it("refreshes from recent requests and answers the matching hot path synchronously", async () => {
    const evidence = new InMemoryEvidenceStore();
    const requests = new RequestService(evidence, new InMemoryRequestStore(), DEFAULT_SERVICE_TYPES);
    const service = new ReputationService(requests, DEFAULT_REPUTATION_POLICY, 500, 60_000);
    // Unknown provider before any data: never suppressed.
    expect(service.isSuppressed("anyone")).toBe(false);
    await service.refresh(t(0));
    expect(service.list()).toEqual([]);
    // Stale check does not throw and keeps the snapshot usable.
    await service.refreshIfStale(t(0));
    expect(service.isSuppressed("anyone")).toBe(false);
  });
});
