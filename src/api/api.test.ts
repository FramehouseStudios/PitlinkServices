import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Server } from "node:http";
import { DEFAULT_SERVICE_TYPES } from "../common/config.js";
import { InMemoryAuthAuditSink } from "../common/auth/guard.js";
import { InMemoryPrincipalStore } from "../common/auth/principalStore.js";
import { InMemoryEvidenceStore } from "../common/evidence/inMemoryStore.js";
import { InMemoryRequestStore } from "../requests/store.js";
import { RequestService } from "../requests/service.js";
import { MatchingEngine } from "../matching/engine.js";
import { InMemoryProviderPresence } from "../realtime/presence.js";
import { PresenceProviderDirectory } from "../realtime/directory.js";
import { TrackingService } from "../realtime/tracking.js";
import { createApi } from "./server.js";
import { signToken } from "../common/auth/token.js";

const SECRET = "api-test-secret";
let server: Server;
let base: string;
let audit: InMemoryAuthAuditSink;
let requests: RequestService;
let engine: MatchingEngine;
let healthy = { postgres: true };

beforeAll(async () => {
  audit = new InMemoryAuthAuditSink();
  const evidence = new InMemoryEvidenceStore();
  requests = new RequestService(evidence, new InMemoryRequestStore(), DEFAULT_SERVICE_TYPES);
  const presence = new InMemoryProviderPresence();
  engine = new MatchingEngine(new PresenceProviderDirectory(presence), requests, evidence, {
    marketplaceEnabled: true,
  });
  server = createApi({
    jwtSecret: SECRET,
    jwtExpiry: "1h",
    defaultCity: "los-angeles",
    members: new InMemoryPrincipalStore("member"),
    providers: new InMemoryPrincipalStore("provider"),
    requests,
    presence,
    tracking: new TrackingService(evidence, requests, { minPingIntervalSeconds: 0 }),
    audit,
    healthChecks: {
      postgres: async () => {
        if (!healthy.postgres) throw new Error("down");
      },
    },
  });
  await new Promise<void>((resolve) => server.listen(0, resolve));
  const address = server.address();
  base = `http://127.0.0.1:${typeof address === "object" && address ? address.port : 0}`;
});

afterAll(() => new Promise<void>((resolve) => server.close(() => resolve())));

async function call(
  method: string,
  path: string,
  opts: { token?: string; key?: string; body?: unknown } = {}
): Promise<{ status: number; json: any }> {
  const response = await fetch(`${base}${path}`, {
    method,
    headers: {
      "content-type": "application/json",
      ...(opts.token ? { authorization: `Bearer ${opts.token}` } : {}),
      ...(opts.key ? { "idempotency-key": opts.key } : {}),
    },
    ...(opts.body !== undefined ? { body: JSON.stringify(opts.body) } : {}),
  });
  return { status: response.status, json: await response.json() };
}

async function signup(email: string): Promise<string> {
  const result = await call("POST", "/members/signup", { body: { email, password: "correct-horse" } });
  expect(result.status).toBe(201);
  return result.json.token as string;
}

describe("member API", () => {
  it("signup → create request → read → timeline → cancel, end to end", async () => {
    const token = await signup("e2e@example.com");
    const created = await call("POST", "/requests", {
      token,
      key: "api-create-1",
      body: { serviceType: "tire_change", lat: 34.05, lng: -118.24 },
    });
    expect(created.status).toBe(201);
    expect(created.json.city).toBe("los-angeles"); // DEFAULT_CITY fallback from config
    expect(created.json.status).toBe("created");

    const id = created.json.id as string;
    expect((await call("GET", `/requests/${id}`, { token })).json.status).toBe("created");

    const cancelled = await call("POST", `/requests/${id}/cancel`, { token, key: "api-cancel-1" });
    expect(cancelled.status).toBe(200);
    expect(cancelled.json.status).toBe("cancelled");

    const timeline = await call("GET", `/requests/${id}/timeline`, { token });
    expect(timeline.json.events.map((e: any) => e.eventType)).toEqual([
      "request.created",
      "request.cancelled",
    ]);
  });

  it("replaying the create key returns the same request", async () => {
    const token = await signup("idem@example.com");
    const body = { serviceType: "tow", lat: 34, lng: -118 };
    const first = await call("POST", "/requests", { token, key: "dup-key", body });
    const replay = await call("POST", "/requests", { token, key: "dup-key", body });
    expect(replay.json.id).toBe(first.json.id);
  });

  it("failure modes: missing idempotency key, unknown service, bad login, duplicate signup", async () => {
    const token = await signup("fail@example.com");
    expect((await call("POST", "/requests", { token, body: { serviceType: "tow", lat: 1, lng: 1 } })).status).toBe(400);
    expect(
      (await call("POST", "/requests", { token, key: "k", body: { serviceType: "helicopter", lat: 1, lng: 1 } })).status
    ).toBe(400);
    expect(
      (await call("POST", "/members/login", { body: { email: "fail@example.com", password: "wrong-horse" } })).status
    ).toBe(401);
    expect(
      (await call("POST", "/members/login", { body: { email: "ghost@example.com", password: "wrong-horse" } })).status
    ).toBe(401);
    expect(
      (await call("POST", "/members/signup", { body: { email: "fail@example.com", password: "correct-horse" } })).status
    ).toBe(409);
  });

  it("adversarial: no token and non-member tokens are rejected and audited", async () => {
    const before = audit.denials.length;
    expect((await call("POST", "/requests", { key: "k", body: {} })).status).toBe(401);
    const providerToken = signToken({ id: "provider-1", type: "provider" }, SECRET, "1h");
    expect((await call("POST", "/requests", { token: providerToken, key: "k", body: {} })).status).toBe(401);
    expect(audit.denials.length).toBe(before + 2);
    expect(audit.denials.at(-1)).toMatchObject({ reason: "wrong_population", actualType: "provider" });
  });

  it("adversarial: one member cannot see, walk the timeline of, or cancel another member's request", async () => {
    const alice = await signup("alice@example.com");
    const mallory = await signup("mallory@example.com");
    const created = await call("POST", "/requests", {
      token: alice,
      key: "alice-1",
      body: { serviceType: "lockout", lat: 34, lng: -118 },
    });
    const id = created.json.id as string;
    // Existence is not leaked: 404, not 403.
    expect((await call("GET", `/requests/${id}`, { token: mallory })).status).toBe(404);
    expect((await call("GET", `/requests/${id}/timeline`, { token: mallory })).status).toBe(404);
    expect((await call("POST", `/requests/${id}/cancel`, { token: mallory, key: "evil" })).status).toBe(404);
    // Alice's request is untouched.
    expect((await call("GET", `/requests/${id}`, { token: alice })).json.status).toBe("created");
  });

  it("health endpoint: 200 when dependencies are up, 503 when one fails", async () => {
    expect(await call("GET", "/health")).toMatchObject({ status: 200, json: { status: "ok" } });
    healthy.postgres = false;
    const degraded = await call("GET", "/health");
    expect(degraded.status).toBe(503);
    expect(degraded.json.checks.postgres).toBe("fail");
    healthy.postgres = true;
  });

  it("provider journey over HTTP: signup → heartbeat → match → en_route → ping → on_scene → resolved", async () => {
    const providerResult = await call("POST", "/providers/signup", {
      body: { email: "pro@example.com", password: "correct-horse" },
    });
    expect(providerResult.status).toBe(201);
    const providerToken = providerResult.json.token as string;

    const beat = await call("POST", "/providers/heartbeat", {
      token: providerToken,
      body: { lat: 34.06, lng: -118.25, serviceTypes: ["tow"] },
    });
    expect(beat.status).toBe(200);

    // Member requests; system triages; engine matches against the heartbeat.
    const memberToken = await signup("journey-member@example.com");
    const created = await call("POST", "/requests", {
      token: memberToken,
      key: "pj-1",
      body: { serviceType: "tow", lat: 34.05, lng: -118.24 },
    });
    const id = created.json.id as string;
    await requests.transition({ type: "system", id: "t" }, id, "triaged", "pj-t");
    const match = await engine.match(id, "pj-m");
    expect(match.matched).toBe(true);

    for (const step of ["en_route", "ping:34.055,-118.245", "on_scene", "resolved"]) {
      if (step.startsWith("ping")) {
        const ping = await call("POST", `/requests/${id}/ping`, {
          token: providerToken,
          body: { lat: 34.055, lng: -118.245 },
        });
        expect(ping.status).toBe(200);
        expect(ping.json.recorded).toBe(true);
      } else {
        const result = await call("POST", `/requests/${id}/${step}`, { token: providerToken, key: `pj-${step}` });
        expect(result.status).toBe(200);
        expect(result.json.status).toBe(step);
      }
    }
    // The member sees the full story in their timeline.
    const timeline = await call("GET", `/requests/${id}/timeline`, { token: memberToken });
    expect(timeline.json.events.map((e: any) => e.eventType)).toContain("request.location_update");
  });

  it("adversarial: member tokens are rejected on provider surfaces; an unassigned provider gets 404, not information", async () => {
    const memberToken = await signup("cross-pop@example.com");
    expect(
      (await call("POST", "/providers/heartbeat", { token: memberToken, body: { lat: 1, lng: 1, serviceTypes: ["tow"] } }))
        .status
    ).toBe(401);

    const imposter = await call("POST", "/providers/signup", {
      body: { email: "imposter@example.com", password: "correct-horse" },
    });
    const created = await call("POST", "/requests", {
      token: memberToken,
      key: "cp-1",
      body: { serviceType: "lockout", lat: 34, lng: -118 },
    });
    const id = created.json.id as string;
    await requests.transition({ type: "system", id: "t" }, id, "triaged", "cp-t");
    // Unassigned provider probing journey + ping endpoints: 404 both.
    expect((await call("POST", `/requests/${id}/en_route`, { token: imposter.json.token, key: "x" })).status).toBe(404);
    expect(
      (await call("POST", `/requests/${id}/ping`, { token: imposter.json.token, body: { lat: 34, lng: -118 } })).status
    ).toBe(404);
  });

  it("failure mode: oversized and malformed bodies are rejected cleanly", async () => {
    const token = await signup("big@example.com");
    const oversized = await fetch(`${base}/requests`, {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "idempotency-key": "k", "content-type": "application/json" },
      body: `{"pad":"${"x".repeat(70 * 1024)}"}`,
    });
    expect(oversized.status).toBe(413);
    const malformed = await fetch(`${base}/members/login`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "not json{",
    });
    expect(malformed.status).toBe(400);
  });
});
