// Integration tests against real Postgres. Skipped unless DATABASE_URL is set
// (run `docker compose up -d && npm run migrate` first, then
// `DATABASE_URL=... npx vitest run`). These verify what unit tests cannot:
// the DB-level append-only trigger and the real store implementations.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import pg from "pg";
import { randomUUID } from "node:crypto";
import { PostgresEvidenceStore } from "./evidence/postgresStore.js";
import { PostgresPrincipalStore } from "./auth/principalStore.js";
import { DuplicateEmailError } from "./auth/principalStore.js";
import type { NewEvidenceEvent } from "./evidence/types.js";
import { PostgresRequestStore } from "../requests/store.js";
import { RequestService } from "../requests/service.js";
import { DEFAULT_SERVICE_TYPES } from "./config.js";

const DATABASE_URL = process.env.DATABASE_URL;

describe.skipIf(!DATABASE_URL)("postgres integration", () => {
  let pool: pg.Pool;

  beforeAll(() => {
    pool = new pg.Pool({ connectionString: DATABASE_URL });
  });

  afterAll(async () => {
    await pool.end();
  });

  function event(requestId: string, overrides: Partial<NewEvidenceEvent> = {}): NewEvidenceEvent {
    return {
      requestId,
      eventType: "request.created",
      payload: { city: "los-angeles" },
      actorType: "member",
      actorId: "member-1",
      calculationRulesVersion: "v1",
      idempotencyKey: `it-${randomUUID()}`,
      occurredAt: new Date("2026-08-26T10:00:00Z"),
      ...overrides,
    };
  }

  it("appends, replays idempotently, and reproduces the timeline", async () => {
    const store = new PostgresEvidenceStore(pool);
    const requestId = randomUUID();
    const first = await store.append(event(requestId));
    const replay = await store.append({ ...event(requestId), idempotencyKey: first.idempotencyKey, payload: { tampered: true } });
    expect(replay.id).toBe(first.id);
    expect(replay.payload).toEqual({ city: "los-angeles" });

    await store.append(
      event(requestId, { eventType: "request.matched", occurredAt: new Date("2026-08-26T10:05:00Z"), actorType: "system", actorId: "matching" })
    );
    const timeline = await store.timeline(requestId);
    expect(timeline.map((e) => e.eventType)).toEqual(["request.created", "request.matched"]);
  });

  it("adversarial: the DB itself rejects UPDATE and DELETE on evidence", async () => {
    const store = new PostgresEvidenceStore(pool);
    const stored = await store.append(event(randomUUID()));
    await expect(
      pool.query("UPDATE evidence_events SET payload = '{}' WHERE id = $1", [stored.id])
    ).rejects.toThrow(/append-only/);
    await expect(
      pool.query("DELETE FROM evidence_events WHERE id = $1", [stored.id])
    ).rejects.toThrow(/append-only/);
  });

  it("request lifecycle end to end against real Postgres, timeline reproducible", async () => {
    const service = new RequestService(
      new PostgresEvidenceStore(pool),
      new PostgresRequestStore(pool),
      DEFAULT_SERVICE_TYPES
    );
    const member = { type: "member" as const, id: randomUUID() };
    const request = await service.create(
      member,
      { serviceType: "jump_start", city: "los-angeles", lat: 34.05, lng: -118.24 },
      `it-${randomUUID()}`
    );
    await service.transition({ type: "system", id: "matching" }, request.id, "triaged", "t1");
    await service.transition({ type: "system", id: "agent" }, request.id, "resolved", "t2");
    const closed = await service.transition({ type: "ops", id: randomUUID() }, request.id, "closed", "t3");
    expect(closed.status).toBe("closed");

    const timeline = await service.timeline(request.id);
    expect(timeline.map((e) => e.eventType)).toEqual([
      "request.created",
      "request.triaged",
      "request.resolved",
      "request.closed",
    ]);
    expect((await service.get(request.id))?.status).toBe("closed");
  });

  it("principal stores: isolated populations, duplicate email rejected per table", async () => {
    const members = new PostgresPrincipalStore(pool, "member");
    const providers = new PostgresPrincipalStore(pool, "provider");
    const email = `it-${randomUUID()}@example.com`;
    const member = await members.create(email, "hash");
    await providers.create(email, "hash");
    await expect(members.create(email.toUpperCase(), "hash")).rejects.toThrow(DuplicateEmailError);

    const found = await members.findByEmail(email);
    expect(found?.id).toBe(member.id);
    expect(found?.type).toBe("member");
    expect(found?.verificationStatus).toBeUndefined();
    expect((await providers.findByEmail(email))?.verificationStatus).toBe("pending");
  });
});
