import { describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { InMemoryEvidenceStore } from "../common/evidence/inMemoryStore.js";
import { FakePaymentsAdapter } from "./adapter.js";
import { PaymentsService, PaymentValidationError } from "./service.js";
import { WebhookIngestor } from "./webhook.js";

const REQUEST_ID = "6f1a2b3c-4d5e-4f60-8a9b-0c1d2e3f4a5b";
const MEMBER_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
// Amounts in tests are arbitrary fixtures — pricing is an open founder RFI.
const INPUT = { memberId: MEMBER_ID, requestId: REQUEST_ID, amountCents: 4200, currency: "usd" };

function setup() {
  const evidence = new InMemoryEvidenceStore();
  const adapter = new FakePaymentsAdapter();
  const service = new PaymentsService(evidence, adapter);
  return { evidence, adapter, service };
}

describe("payments service", () => {
  it("happy path: intent on the spine BEFORE the rail, then succeeded", async () => {
    const { evidence, adapter, service } = setup();
    const result = await service.chargeForRequest(INPUT, "charge-1");
    expect(result).toMatchObject({ ok: true });

    const timeline = await evidence.timeline(REQUEST_ID);
    expect(timeline.map((e) => e.eventType)).toEqual(["payment.intent_created", "payment.succeeded"]);
    expect(timeline[0]!.occurredAt.getTime()).toBeLessThanOrEqual(timeline[1]!.occurredAt.getTime());
    expect(adapter.charges).toHaveLength(1);
    expect(timeline[1]!.payload).toMatchObject({ amountCents: 4200, currency: "usd" });
  });

  it("failure path: rail declines → payment.failed compensating record, no retry side effects", async () => {
    const { evidence, adapter, service } = setup();
    adapter.failNext("charge-declined", "card_declined");
    const result = await service.chargeForRequest(INPUT, "charge-declined");
    expect(result).toEqual({ ok: false, failureReason: "card_declined" });
    const timeline = await evidence.timeline(REQUEST_ID);
    expect(timeline.map((e) => e.eventType)).toEqual(["payment.intent_created", "payment.failed"]);
    expect(timeline[1]!.payload).toMatchObject({ failureReason: "card_declined" });
  });

  it("idempotency: a replayed charge key charges once and returns the original outcome", async () => {
    const { evidence, adapter, service } = setup();
    const first = await service.chargeForRequest(INPUT, "charge-once");
    const replay = await service.chargeForRequest({ ...INPUT, amountCents: 9999 }, "charge-once");
    expect(replay).toEqual(first);
    expect(adapter.charges).toHaveLength(1);
    expect(await evidence.timeline(REQUEST_ID)).toHaveLength(2);
  });

  it("adversarial: crash between intent and result — retry completes with no duplicate intent or double charge", async () => {
    const { evidence, adapter, service } = setup();
    adapter.crashNext("charge-crash");
    await expect(service.chargeForRequest(INPUT, "charge-crash")).rejects.toThrow(/unreachable/);
    // Intent is on the spine, no outcome yet.
    expect((await evidence.timeline(REQUEST_ID)).map((e) => e.eventType)).toEqual(["payment.intent_created"]);
    // Retry with the same key: completes; exactly one intent, one outcome, one charge.
    const retry = await service.chargeForRequest(INPUT, "charge-crash");
    expect(retry).toMatchObject({ ok: true });
    expect((await evidence.timeline(REQUEST_ID)).map((e) => e.eventType)).toEqual([
      "payment.intent_created",
      "payment.succeeded",
    ]);
    expect(adapter.charges).toHaveLength(1);
  });

  it("failure mode: invalid amounts and currencies are rejected before any evidence", async () => {
    const { evidence, service } = setup();
    await expect(service.chargeForRequest({ ...INPUT, amountCents: 0 }, "k")).rejects.toThrow(PaymentValidationError);
    await expect(service.chargeForRequest({ ...INPUT, amountCents: 12.5 }, "k")).rejects.toThrow(PaymentValidationError);
    await expect(service.chargeForRequest({ ...INPUT, currency: "dollars" }, "k")).rejects.toThrow(PaymentValidationError);
    expect(await evidence.timeline(REQUEST_ID)).toHaveLength(0);
  });
});

describe("webhook ingestion (exactly-once)", () => {
  it("processes once, deduplicates redelivery", async () => {
    const ingestor = new WebhookIngestor();
    let handled = 0;
    ingestor.on("payment.settled", async () => {
      handled++;
    });
    const raw = JSON.stringify({ id: `evt-${randomUUID()}`, type: "payment.settled", data: {} });
    expect(await ingestor.ingest(raw)).toEqual({ status: "processed" });
    expect(await ingestor.ingest(raw)).toEqual({ status: "duplicate" });
    expect(handled).toBe(1);
  });

  it("dead-letters malformed payloads, unknown types, and handler failures — replay recovers exactly once", async () => {
    const ingestor = new WebhookIngestor();
    expect((await ingestor.ingest("not json{")).status).toBe("dead_lettered");
    expect((await ingestor.ingest(JSON.stringify({ type: "x" }))).status).toBe("dead_lettered");

    // Unknown type now, handler registered later → replay succeeds once.
    let handled = 0;
    const raw = JSON.stringify({ id: "evt-late", type: "payment.settled", data: {} });
    expect((await ingestor.ingest(raw)).status).toBe("dead_lettered");
    ingestor.on("payment.settled", async () => {
      handled++;
    });
    const letters = ingestor.deadLetters();
    expect(letters).toHaveLength(3);
    const late = letters.find((l) => l.raw === raw)!;
    expect(await ingestor.replay(late.letterId)).toEqual({ status: "processed" });
    // Letter consumed; direct redelivery of the same id is a duplicate.
    expect(ingestor.deadLetters()).toHaveLength(2);
    expect(await ingestor.ingest(raw)).toEqual({ status: "duplicate" });
    expect(handled).toBe(1);
  });

  it("failure mode: a throwing handler dead-letters WITHOUT marking processed — retry works", async () => {
    const ingestor = new WebhookIngestor();
    let attempts = 0;
    ingestor.on("payment.settled", async () => {
      attempts++;
      if (attempts === 1) throw new Error("db blip");
    });
    const raw = JSON.stringify({ id: "evt-retry", type: "payment.settled", data: {} });
    expect((await ingestor.ingest(raw)).status).toBe("dead_lettered");
    expect((await ingestor.ingest(raw)).status).toBe("processed");
    expect(attempts).toBe(2);
  });
});
