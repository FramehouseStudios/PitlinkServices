// Member-facing live status over WebSockets. Auth and ownership are checked
// BEFORE the socket joins anything: a member can subscribe only to their own
// request (4404 otherwise — existence is not leaked, mirroring the REST
// surface). On subscribe the client gets a snapshot (request + full timeline
// from the spine), then live events as they are recorded.
import type { Server } from "node:http";
import { WebSocketServer, type WebSocket } from "ws";
import { requirePrincipal, type AuthAuditSink } from "../common/auth/guard.js";
import type { RequestService } from "../requests/service.js";
import type { RequestEventBus } from "./bus.js";

export interface WsDeps {
  jwtSecret: string;
  requests: RequestService;
  bus: RequestEventBus;
  audit: AuthAuditSink;
}

export const WS_PATH = "/ws";

export function attachWs(server: Server, deps: WsDeps): WebSocketServer {
  const wss = new WebSocketServer({ server, path: WS_PATH });

  wss.on("connection", (socket: WebSocket, req) => {
    void (async () => {
      const url = new URL(req.url ?? "/", "http://localhost");
      const token = url.searchParams.get("token") ?? "";
      const requestId = url.searchParams.get("requestId") ?? "";

      let memberId: string;
      try {
        memberId = requirePrincipal(token, "member", deps.jwtSecret, deps.audit).sub;
      } catch {
        socket.close(4401, "unauthorized");
        return;
      }

      const record = await deps.requests.get(requestId);
      if (!record || record.memberId !== memberId) {
        socket.close(4404, "not found");
        return;
      }

      const unsubscribe = deps.bus.subscribe(requestId, (event) => {
        socket.send(JSON.stringify({ type: "event", event }));
      });
      socket.on("close", unsubscribe);
      socket.on("error", unsubscribe);

      socket.send(
        JSON.stringify({
          type: "snapshot",
          request: record,
          events: await deps.requests.timeline(requestId),
        })
      );
    })().catch(() => socket.close(1011, "internal error"));
  });

  return wss;
}
