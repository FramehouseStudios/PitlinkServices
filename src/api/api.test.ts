import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Server } from "node:http";
import { DEFAULT_SERVICE_TYPES } from "../common/config.js";
import { InMemoryAuthAuditSink } from "../common/auth/guard.js";
import { InMemoryPrincipalStore } from "../common/auth/principalStore.js";
import { InMemoryEvidenceStore } from "../common/evidence/inMemoryStore.js";
import { InMemoryRequestStore } from "../requests/store.js";
import { RequestService } from "../requests/service.js";
import { createApi } from "./server.js";
import { signToken } from "../common/auth/token.js";

const SECRET = "api-test-secret";
let server: Server;
let base: string;
let audit: InMemoryAuthAuditSink;

beforeAll(async () => {
  audit = new InMemoryAuthAuditSink();
  server = createApi({
    jwtSecret: SECRET,
    jwtExpiry: "1h",
    defaultCity: "los-angeles",
    members: new InMemoryPrincipalStore("member"),
    requests: new RequestService(new InMemoryEvidenceStore(), new InMemoryRequestStore(), DEFAULT_SERVICE_TYPES),
    audit,
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
