import { describe, expect, it } from "vitest";
import { InMemoryEvidenceStore } from "./inMemoryStore.js";
import { EvidenceValidationError, type NewEvidenceEvent } from "./types.js";

const REQUEST_ID = "6f1a2b3c-4d5e-4f60-8a9b-0c1d2e3f4a5b";

function event(overrides: Partial<NewEvidenceEvent> = {}): NewEvidenceEvent {
  return {
    requestId: REQUEST_ID,
    eventType: "request.created",
    payload: { city: "los-angeles" },
    actorType: "member",
    actorId: "member-1",
    calculationRulesVersion: "v1",
    idempotencyKey: "key-1",
    occurredAt: new Date("2026-08-26T10:00:00Z"),
    ...overrides,
  };
}

describe("evidence spine", () => {
  it("appends events and reproduces the timeline in occurrence order", async () => {
    const store = new InMemoryEvidenceStore();
    await store.append(
      event({ eventType: "request.matched", idempotencyKey: "key-2", occurredAt: new Date("2026-08-26T10:05:00Z"), actorType: "system", actorId: "matching" })
    );
    await store.append(event()); // occurred earlier, appended later
    const timeline = await store.timeline(REQUEST_ID);
    expect(timeline.map((e) => e.eventType)).toEqual(["request.created", "request.matched"]);
  });

  it("is idempotent: a replayed idempotency key returns the original event", async () => {
    const store = new InMemoryEvidenceStore();
    const first = await store.append(event());
    const replay = await store.append(event({ payload: { tampered: true } }));
    expect(replay.id).toBe(first.id);
    expect(replay.payload).toEqual({ city: "los-angeles" });
    expect(await store.timeline(REQUEST_ID)).toHaveLength(1);
  });

  it("exposes no mutation surface (append-only by construction)", async () => {
    const store = new InMemoryEvidenceStore();
    expect((store as unknown as Record<string, unknown>)["update"]).toBeUndefined();
    expect((store as unknown as Record<string, unknown>)["delete"]).toBeUndefined();
    // Mutating a returned event must not corrupt the stored record.
    const stored = await store.append(event());
    stored.payload["city"] = "hacked";
    const [fromTimeline] = await store.timeline(REQUEST_ID);
    expect(fromTimeline?.payload).toEqual({ city: "los-angeles" });
  });

  it("failure mode: rejects malformed events before storage", async () => {
    const store = new InMemoryEvidenceStore();
    await expect(store.append(event({ requestId: "not-a-uuid" }))).rejects.toThrow(EvidenceValidationError);
    await expect(store.append(event({ eventType: "  " }))).rejects.toThrow(EvidenceValidationError);
    await expect(
      store.append(event({ actorType: "admin" as never }))
    ).rejects.toThrow(EvidenceValidationError);
    await expect(store.append(event({ idempotencyKey: "" }))).rejects.toThrow(EvidenceValidationError);
    expect(await store.timeline(REQUEST_ID)).toHaveLength(0);
  });
});
