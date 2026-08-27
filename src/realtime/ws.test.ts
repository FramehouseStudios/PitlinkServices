import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createServer, type Server } from "node:http";
import WebSocket from "ws";
import { DEFAULT_SERVICE_TYPES } from "../common/config.js";
import { InMemoryAuthAuditSink } from "../common/auth/guard.js";
import { signToken } from "../common/auth/token.js";
import { InMemoryEvidenceStore } from "../common/evidence/inMemoryStore.js";
import { RequestService } from "../requests/service.js";
import { InMemoryRequestStore } from "../requests/store.js";
import { RequestEventBus } from "./bus.js";
import { attachWs } from "./ws.js";

const SECRET = "ws-test-secret";
const MEMBER_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const OTHER_ID = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";

let server: Server;
let base: string;
let requests: RequestService;
let requestId: string;

function connect(params: Record<string, string>): WebSocket {
  const qs = new URLSearchParams(params).toString();
  return new WebSocket(`${base}/ws?${qs}`);
}

function nextMessage(socket: WebSocket): Promise<any> {
  return new Promise((resolve, reject) => {
    socket.once("message", (data) => resolve(JSON.parse(data.toString())));
    socket.once("close", (code) => reject(new Error(`closed ${code}`)));
    socket.once("error", reject);
  });
}

function closeCode(socket: WebSocket): Promise<number> {
  return new Promise((resolve) => socket.once("close", resolve));
}

beforeAll(async () => {
  const bus = new RequestEventBus();
  requests = new RequestService(
    new InMemoryEvidenceStore(),
    new InMemoryRequestStore(),
    DEFAULT_SERVICE_TYPES,
    (e) => bus.publish(e)
  );
  server = createServer();
  attachWs(server, { jwtSecret: SECRET, requests, bus, audit: new InMemoryAuthAuditSink() });
  await new Promise<void>((resolve) => server.listen(0, resolve));
  const address = server.address();
  base = `ws://127.0.0.1:${typeof address === "object" && address ? address.port : 0}`;

  const record = await requests.create(
    { type: "member", id: MEMBER_ID },
    { serviceType: "tow", city: "los-angeles", lat: 34.05, lng: -118.24 },
    "ws-create"
  );
  requestId = record.id;
});

afterAll(() => new Promise<void>((resolve) => server.close(() => resolve())));

describe("websocket status surface", () => {
  it("owner subscribes: snapshot first, then live events as the request moves", async () => {
    const token = signToken({ id: MEMBER_ID, type: "member" }, SECRET, "1h");
    const socket = connect({ token, requestId });
    const snapshot = await nextMessage(socket);
    expect(snapshot.type).toBe("snapshot");
    expect(snapshot.request.id).toBe(requestId);
    expect(snapshot.events.map((e: any) => e.eventType)).toEqual(["request.created"]);

    const livePromise = nextMessage(socket);
    await requests.transition({ type: "system", id: "t" }, requestId, "triaged", "ws-t1");
    const live = await livePromise;
    expect(live.type).toBe("event");
    expect(live.event.eventType).toBe("request.triaged");
    socket.close();
  });

  it("adversarial: invalid token → 4401; another member's token → 4404; unknown request → 4404", async () => {
    expect(await closeCode(connect({ token: "garbage", requestId }))).toBe(4401);
    const providerToken = signToken({ id: "p1", type: "provider" }, SECRET, "1h");
    expect(await closeCode(connect({ token: providerToken, requestId }))).toBe(4401);
    const otherToken = signToken({ id: OTHER_ID, type: "member" }, SECRET, "1h");
    expect(await closeCode(connect({ token: otherToken, requestId }))).toBe(4404);
    const ownToken = signToken({ id: MEMBER_ID, type: "member" }, SECRET, "1h");
    expect(
      await closeCode(connect({ token: ownToken, requestId: "00000000-0000-4000-8000-000000000000" }))
    ).toBe(4404);
  });
});
