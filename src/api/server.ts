// Minimal owned HTTP surface over node:http — no framework until a measured
// trigger says otherwise. JSON only. Bodies are size-capped. Nothing here
// logs request bodies, tokens, or credentials.
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { AuthorizationError, requirePrincipal, type AuthAuditSink } from "../common/auth/guard.js";
import { hashPassword, verifyPassword } from "../common/auth/password.js";
import { signToken } from "../common/auth/token.js";
import { DuplicateEmailError, type PrincipalStore } from "../common/auth/principalStore.js";
import type { RequestService } from "../requests/service.js";
import {
  IllegalTransitionError,
  RequestNotFoundError,
  RequestValidationError,
} from "../requests/types.js";

export interface ApiDeps {
  jwtSecret: string;
  jwtExpiry: string;
  defaultCity: string;
  members: PrincipalStore;
  requests: RequestService;
  audit: AuthAuditSink;
}

const MAX_BODY_BYTES = 64 * 1024;

class HttpError extends Error {
  constructor(public readonly status: number, message: string) {
    super(message);
  }
}

async function readJson(req: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > MAX_BODY_BYTES) throw new HttpError(413, "body too large");
    chunks.push(chunk as Buffer);
  }
  if (chunks.length === 0) return {};
  try {
    const parsed = JSON.parse(Buffer.concat(chunks).toString());
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      throw new Error();
    }
    return parsed as Record<string, unknown>;
  } catch {
    throw new HttpError(400, "invalid JSON body");
  }
}

function str(body: Record<string, unknown>, field: string): string {
  const value = body[field];
  if (typeof value !== "string" || !value.trim()) throw new HttpError(400, `${field} is required`);
  return value;
}

function num(body: Record<string, unknown>, field: string): number {
  const value = body[field];
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new HttpError(400, `${field} must be a number`);
  }
  return value;
}

export function createApi(deps: ApiDeps): Server {
  const memberClaims = (req: IncomingMessage) => {
    const header = req.headers.authorization ?? "";
    const token = header.startsWith("Bearer ") ? header.slice(7) : "";
    return requirePrincipal(token, "member", deps.jwtSecret, deps.audit);
  };

  const idempotencyKey = (req: IncomingMessage): string => {
    const key = req.headers["idempotency-key"];
    if (typeof key !== "string" || !key.trim()) {
      throw new HttpError(400, "Idempotency-Key header is required");
    }
    return key;
  };

  // A member sees only their own requests; anything else is a 404 so that
  // request ids are not enumerable across members.
  const ownRequest = async (id: string, memberId: string) => {
    const record = await deps.requests.get(id);
    if (!record || record.memberId !== memberId) throw new HttpError(404, "not found");
    return record;
  };

  const handle = async (req: IncomingMessage, res: ServerResponse): Promise<[number, unknown]> => {
    const url = new URL(req.url ?? "/", "http://localhost");
    const path = url.pathname.replace(/\/+$/, "") || "/";
    const route = `${req.method} ${path}`;

    if (route === "POST /members/signup") {
      const body = await readJson(req);
      const email = str(body, "email");
      if (!email.includes("@")) throw new HttpError(400, "email must be valid");
      let passwordHash: string;
      try {
        passwordHash = await hashPassword(str(body, "password"));
      } catch (err) {
        throw new HttpError(400, (err as Error).message);
      }
      try {
        const member = await deps.members.create(email, passwordHash);
        const token = signToken({ id: member.id, type: "member" }, deps.jwtSecret, deps.jwtExpiry);
        return [201, { token, member: { id: member.id, email: member.email } }];
      } catch (err) {
        if (err instanceof DuplicateEmailError) throw new HttpError(409, "email already registered");
        throw err;
      }
    }

    if (route === "POST /members/login") {
      const body = await readJson(req);
      const stored = await deps.members.findByEmail(str(body, "email"));
      // Identical failure response for unknown email and wrong password.
      const ok = stored && (await verifyPassword(str(body, "password"), stored.passwordHash));
      if (!ok) throw new HttpError(401, "invalid credentials");
      const token = signToken({ id: stored.id, type: "member" }, deps.jwtSecret, deps.jwtExpiry);
      return [200, { token }];
    }

    if (route === "POST /requests") {
      const claims = memberClaims(req);
      const key = idempotencyKey(req);
      const body = await readJson(req);
      const record = await deps.requests.create(
        { type: "member", id: claims.sub },
        {
          serviceType: str(body, "serviceType"),
          city: typeof body.city === "string" && body.city.trim() ? body.city : deps.defaultCity,
          lat: num(body, "lat"),
          lng: num(body, "lng"),
        },
        key
      );
      return [201, record];
    }

    const requestMatch = /^GET \/requests\/([0-9a-f-]{36})$/.exec(route);
    if (requestMatch) {
      const claims = memberClaims(req);
      return [200, await ownRequest(requestMatch[1]!, claims.sub)];
    }

    const timelineMatch = /^GET \/requests\/([0-9a-f-]{36})\/timeline$/.exec(route);
    if (timelineMatch) {
      const claims = memberClaims(req);
      const record = await ownRequest(timelineMatch[1]!, claims.sub);
      return [200, { requestId: record.id, events: await deps.requests.timeline(record.id) }];
    }

    const cancelMatch = /^POST \/requests\/([0-9a-f-]{36})\/cancel$/.exec(route);
    if (cancelMatch) {
      const claims = memberClaims(req);
      const key = idempotencyKey(req);
      const record = await ownRequest(cancelMatch[1]!, claims.sub);
      return [200, await deps.requests.transition({ type: "member", id: claims.sub }, record.id, "cancelled", key)];
    }

    throw new HttpError(404, "not found");
  };

  return createServer((req, res) => {
    handle(req, res)
      .then(([status, payload]) => {
        res.writeHead(status, { "content-type": "application/json" });
        res.end(JSON.stringify(payload));
      })
      .catch((err: unknown) => {
        let status = 500;
        let message = "internal error";
        if (err instanceof HttpError) ({ status, message } = err);
        else if (err instanceof AuthorizationError) [status, message] = [401, "unauthorized"];
        else if (err instanceof RequestValidationError) [status, message] = [400, err.message];
        else if (err instanceof RequestNotFoundError) [status, message] = [404, "not found"];
        else if (err instanceof IllegalTransitionError) [status, message] = [409, err.message];
        // 5xx details stay server-side; clients get no internals.
        if (status >= 500) console.error("api error:", (err as Error).name, (err as Error).message);
        res.writeHead(status, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: message }));
      });
  });
}
