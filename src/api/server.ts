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
import type { ProviderPresence } from "../realtime/presence.js";
import type { TrackingService } from "../realtime/tracking.js";
import { VehicleValidationError, type Powertrain, type VehicleStore } from "../members/vehicles.js";
import { fleetMetrics, providerRatings } from "../common/metrics/calculations.js";
import { reconcileRequest } from "../common/metrics/reconcile.js";
import { serviceHealth } from "../reliability/alerts.js";
import type { ReliabilityService } from "../reliability/service.js";
import type { ReputationService } from "../reliability/reputation.js";
import { silentLogger, type Logger } from "../common/logger.js";
import type { PrincipalType } from "../common/auth/principals.js";

export interface ApiDeps {
  jwtSecret: string;
  jwtExpiry: string;
  defaultCity: string;
  /** Service catalog exposed to clients via GET /catalog. */
  serviceTypes?: readonly string[];
  /** Absolute path to the member web app HTML; GET / serves it when set. */
  webAppPath?: string;
  /** Absolute path to the provider web app HTML; GET /provider serves it. */
  providerAppPath?: string;
  /** Absolute path to the ops console HTML; GET /ops serves it. */
  opsAppPath?: string;
  members: PrincipalStore;
  providers: PrincipalStore;
  /** Ops principals are seeded by script (scripts/seed-ops.ts), NEVER
   * self-signup — the API exposes only ops login. */
  ops: PrincipalStore;
  vehicles: VehicleStore;
  requests: RequestService;
  /** Optional: enables GET /ops/health and POST /ops/sweep. */
  reliability?: ReliabilityService;
  /** Optional: enables GET /ops/providers (quality standings). */
  reputation?: ReputationService;
  /** Optional: enables operator-forced rematch. */
  matching?: { match(requestId: string, attemptKey: string): Promise<unknown> };
  presence: ProviderPresence;
  tracking: TrackingService;
  audit: AuthAuditSink;
  logger?: Logger;
  /** Dependency reachability checks for GET /health (name → probe). */
  healthChecks?: Record<string, () => Promise<void>>;
  /** Presence heartbeat TTL. ESTIMATE default 60s. */
  presenceTtlSeconds?: number;
}

const MAX_BODY_BYTES = 64 * 1024;

// The member web app is a single static file, read once and cached.
let webAppCache: string | null = null;
async function readWebApp(path: string): Promise<string> {
  if (webAppCache === null) {
    const { readFile } = await import("node:fs/promises");
    webAppCache = await readFile(path, "utf8");
  }
  return webAppCache;
}

let providerAppCache: string | null = null;
async function readProviderApp(path: string): Promise<string> {
  if (providerAppCache === null) {
    const { readFile } = await import("node:fs/promises");
    providerAppCache = await readFile(path, "utf8");
  }
  return providerAppCache;
}

let opsAppCache: string | null = null;
async function readOpsApp(path: string): Promise<string> {
  if (opsAppCache === null) {
    const { readFile } = await import("node:fs/promises");
    opsAppCache = await readFile(path, "utf8");
  }
  return opsAppCache;
}

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
  const logger = deps.logger ?? silentLogger;

  const claims = (req: IncomingMessage, type: PrincipalType) => {
    const header = req.headers.authorization ?? "";
    const token = header.startsWith("Bearer ") ? header.slice(7) : "";
    return requirePrincipal(token, type, deps.jwtSecret, deps.audit);
  };
  const memberClaims = (req: IncomingMessage) => claims(req, "member");
  const providerClaims = (req: IncomingMessage) => claims(req, "provider");

  // Shared signup/login for a population — stores stay structurally separate.
  const signup = async (req: IncomingMessage, store: PrincipalStore): Promise<[number, unknown]> => {
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
      const principal = await store.create(email, passwordHash);
      const token = signToken({ id: principal.id, type: store.type }, deps.jwtSecret, deps.jwtExpiry);
      return [201, { token, [store.type]: { id: principal.id, email: principal.email } }];
    } catch (err) {
      if (err instanceof DuplicateEmailError) throw new HttpError(409, "email already registered");
      throw err;
    }
  };
  const login = async (req: IncomingMessage, store: PrincipalStore): Promise<[number, unknown]> => {
    const body = await readJson(req);
    const stored = await store.findByEmail(str(body, "email"));
    // Identical failure response for unknown email and wrong password.
    const ok = stored && (await verifyPassword(str(body, "password"), stored.passwordHash));
    if (!ok) throw new HttpError(401, "invalid credentials");
    const token = signToken({ id: stored.id, type: store.type }, deps.jwtSecret, deps.jwtExpiry);
    return [200, { token }];
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

    if (route === "GET /" && deps.webAppPath) {
      const html = await readWebApp(deps.webAppPath);
      return [200, { __raw: html, contentType: "text/html; charset=utf-8" }];
    }

    if (route === "GET /provider" && deps.providerAppPath) {
      const html = await readProviderApp(deps.providerAppPath);
      return [200, { __raw: html, contentType: "text/html; charset=utf-8" }];
    }

    if (route === "GET /ops" && deps.opsAppPath) {
      const html = await readOpsApp(deps.opsAppPath);
      return [200, { __raw: html, contentType: "text/html; charset=utf-8" }];
    }

    if (route === "GET /catalog") {
      // Public, non-sensitive: what a client needs to render the request form.
      return [200, { serviceTypes: deps.serviceTypes ?? [], defaultCity: deps.defaultCity }];
    }

    if (route === "GET /health") {
      const checks = deps.healthChecks ?? {};
      const results: Record<string, "ok" | "fail"> = {};
      let healthy = true;
      for (const [name, probe] of Object.entries(checks)) {
        try {
          await probe();
          results[name] = "ok";
        } catch {
          results[name] = "fail";
          healthy = false;
        }
      }
      return [healthy ? 200 : 503, { status: healthy ? "ok" : "degraded", checks: results }];
    }

    if (route === "POST /members/signup") return signup(req, deps.members);
    if (route === "POST /members/login") return login(req, deps.members);
    if (route === "POST /providers/signup") return signup(req, deps.providers);
    if (route === "POST /providers/login") return login(req, deps.providers);
    // Deliberately no POST /ops/signup — ops principals are seeded by script.
    if (route === "POST /ops/login") return login(req, deps.ops);

    if (route === "GET /ops/metrics") {
      claims(req, "ops");
      const limit = Math.min(Number(url.searchParams.get("limit") ?? 100) || 100, 500);
      const recent = await deps.requests.listRecent(limit);
      const timelines = await Promise.all(recent.map((r) => deps.requests.timeline(r.id)));
      return [200, { ...fleetMetrics(timelines), providerRatings: providerRatings(timelines) }];
    }

    if (route === "GET /ops/board") {
      claims(req, "ops");
      // One call for the whole console: health, what is in flight right now,
      // what needs a human, and who is working.
      const recent = await deps.requests.listRecent(100);
      const timelines = await Promise.all(recent.map((r) => deps.requests.timeline(r.id)));
      const inFlightRecords = await deps.requests.listByStatus(
        ["created", "triaged", "matched", "en_route", "on_scene"],
        100
      );
      const nowMs = Date.now();
      const inFlight = await Promise.all(
        inFlightRecords.map(async (record) => {
          const timeline = await deps.requests.timeline(record.id);
          const created = timeline.find((e) => e.eventType === "request.created");
          const escalated = timeline.some((e) => e.eventType === "request.escalated");
          const noShows = timeline.filter((e) => e.eventType === "provider.no_show").length;
          return {
            id: record.id,
            serviceType: record.serviceType,
            city: record.city,
            status: record.status,
            ageMinutes: created ? Math.round((nowMs - created.occurredAt.getTime()) / 60000) : null,
            providerId: await deps.requests.assignedProvider(record.id),
            escalated,
            noShows,
          };
        })
      );
      // Needs-a-human first, then oldest.
      inFlight.sort(
        (a, b) =>
          Number(b.escalated) - Number(a.escalated) ||
          b.noShows - a.noShows ||
          (b.ageMinutes ?? 0) - (a.ageMinutes ?? 0)
      );
      let providers: unknown[] = [];
      if (deps.reputation) {
        await deps.reputation.refreshIfStale();
        providers = deps.reputation.list();
      }
      return [200, { health: serviceHealth(timelines), inFlight, providers }];
    }

    const opsRematch = /^POST \/ops\/requests\/([0-9a-f-]{36})\/rematch$/.exec(route);
    if (opsRematch) {
      claims(req, "ops");
      if (!deps.matching) throw new HttpError(503, "matching not configured");
      // Forces a fresh match attempt; every outcome lands on the spine like
      // any other match, so an operator's intervention is auditable.
      return [200, await deps.matching.match(opsRematch[1]!, `ops-rematch:${Date.now()}`)];
    }

    const opsCancel = /^POST \/ops\/requests\/([0-9a-f-]{36})\/cancel$/.exec(route);
    if (opsCancel) {
      const ops = claims(req, "ops");
      const key = idempotencyKey(req);
      // Ops cancellation is a privileged write: attributed to the operator,
      // audited on the spine by the normal transition path.
      return [
        200,
        await deps.requests.transition({ type: "ops", id: ops.sub }, opsCancel[1]!, "cancelled", key),
      ];
    }

    if (route === "GET /ops/health") {
      claims(req, "ops");
      const limit = Math.min(Number(url.searchParams.get("limit") ?? 100) || 100, 500);
      const recent = await deps.requests.listRecent(limit);
      const timelines = await Promise.all(recent.map((r) => deps.requests.timeline(r.id)));
      return [200, serviceHealth(timelines)];
    }

    if (route === "GET /ops/providers") {
      claims(req, "ops");
      if (!deps.reputation) throw new HttpError(503, "reputation service not configured");
      await deps.reputation.refresh();
      const standings = deps.reputation.list();
      return [200, { providers: standings, suppressed: standings.filter((p) => p.suppressed).length }];
    }

    if (route === "POST /ops/sweep") {
      claims(req, "ops");
      if (!deps.reliability) throw new HttpError(503, "reliability sweep not configured");
      return [200, await deps.reliability.sweep()];
    }

    if (route === "GET /ops/reconciliation") {
      claims(req, "ops");
      const limit = Math.min(Number(url.searchParams.get("limit") ?? 100) || 100, 500);
      const recent = await deps.requests.listRecent(limit);
      const discrepancies = [];
      for (const record of recent) {
        const result = reconcileRequest(await deps.requests.timeline(record.id), record);
        if (!result.consistent) discrepancies.push({ requestId: record.id, ...result });
      }
      return [200, { checked: recent.length, consistent: recent.length - discrepancies.length, discrepancies }];
    }

    if (route === "POST /providers/heartbeat") {
      const provider = providerClaims(req);
      const body = await readJson(req);
      const serviceTypes = body.serviceTypes;
      if (!Array.isArray(serviceTypes) || serviceTypes.some((s) => typeof s !== "string") || serviceTypes.length === 0) {
        throw new HttpError(400, "serviceTypes must be a non-empty string array");
      }
      await deps.presence.heartbeat(
        {
          providerId: provider.sub,
          serviceTypes: serviceTypes as string[],
          city: typeof body.city === "string" && body.city.trim() ? body.city : deps.defaultCity,
          lat: num(body, "lat"),
          lng: num(body, "lng"),
          available: body.available !== false,
        },
        deps.presenceTtlSeconds ?? 60
      );
      return [200, { ok: true, ttlSeconds: deps.presenceTtlSeconds ?? 60 }];
    }

    if (route === "GET /providers/me") {
      const provider = providerClaims(req);
      // Fairness: a provider sees exactly the standing ops sees, including
      // why they are suppressed. No hidden scores.
      let standing = null;
      if (deps.reputation) {
        await deps.reputation.refreshIfStale();
        standing =
          deps.reputation.list().find((p) => p.providerId === provider.sub) ?? {
            providerId: provider.sub,
            accepted: 0,
            noShows: 0,
            completed: 0,
            noShowRate: 0,
            ratingCount: 0,
            avgRating: null,
            suppressed: false,
            suppressionReasons: [],
          };
      }
      return [200, { providerId: provider.sub, standing }];
    }

    if (route === "GET /providers/jobs/current") {
      const provider = providerClaims(req);
      const active = await deps.requests.listByStatus(["matched", "en_route", "on_scene"], 200);
      // Newest first: a provider holds one job, but never let a stale row
      // mask the live one.
      const mine = [];
      for (const record of active) {
        if ((await deps.requests.assignedProvider(record.id)) === provider.sub) mine.push(record);
      }
      mine.sort((a, b) => b.updatedAt.getTime() - a.updatedAt.getTime());
      return [200, { job: mine[0] ?? null }];
    }

    const journeyMatch = /^POST \/requests\/([0-9a-f-]{36})\/(en_route|on_scene|resolved)$/.exec(route);
    if (journeyMatch) {
      const provider = providerClaims(req);
      const key = idempotencyKey(req);
      const [, id, to] = journeyMatch as unknown as [string, string, "en_route" | "on_scene" | "resolved"];
      try {
        return [200, await deps.requests.transition({ type: "provider", id: provider.sub }, id, to, key)];
      } catch (err) {
        // Assignment failures are masked: a probing provider learns nothing.
        if (err instanceof IllegalTransitionError && err.reason === "not_assigned_provider") {
          throw new HttpError(404, "not found");
        }
        throw err;
      }
    }

    const pingMatch = /^POST \/requests\/([0-9a-f-]{36})\/ping$/.exec(route);
    if (pingMatch) {
      const provider = providerClaims(req);
      const body = await readJson(req);
      const result = await deps.tracking.providerPing(
        provider.sub,
        pingMatch[1]!,
        num(body, "lat"),
        num(body, "lng")
      );
      if (!result.recorded) {
        if (result.reason === "not_assigned_provider") throw new HttpError(404, "not found");
        if (result.reason === "invalid_coordinates") throw new HttpError(400, "invalid coordinates");
        if (result.reason === "request_not_en_route") throw new HttpError(409, "request not en_route");
      }
      return [200, result];
    }

    if (route === "POST /vehicles") {
      const claims = memberClaims(req);
      const body = await readJson(req);
      try {
        const vehicle = await deps.vehicles.create(claims.sub, {
          make: str(body, "make"),
          model: str(body, "model"),
          ...(body.year !== undefined ? { year: num(body, "year") } : {}),
          ...(typeof body.powertrain === "string" ? { powertrain: body.powertrain as Powertrain } : {}),
        });
        return [201, vehicle];
      } catch (err) {
        if (err instanceof VehicleValidationError) throw new HttpError(400, err.message);
        throw err;
      }
    }

    if (route === "GET /vehicles") {
      const claims = memberClaims(req);
      return [200, { vehicles: await deps.vehicles.listByMember(claims.sub) }];
    }

    if (route === "POST /requests") {
      const claims = memberClaims(req);
      const key = idempotencyKey(req);
      const body = await readJson(req);
      let vehicle;
      if (body.vehicleId !== undefined) {
        const owned = await deps.vehicles.findOwned(claims.sub, str(body, "vehicleId"));
        if (!owned) throw new HttpError(404, "vehicle not found");
        vehicle = { id: owned.id, make: owned.make, model: owned.model, powertrain: owned.powertrain };
      }
      const record = await deps.requests.create(
        { type: "member", id: claims.sub },
        {
          serviceType: str(body, "serviceType"),
          city: typeof body.city === "string" && body.city.trim() ? body.city : deps.defaultCity,
          lat: num(body, "lat"),
          lng: num(body, "lng"),
          ...(vehicle ? { vehicle } : {}),
        },
        key
      );
      return [201, record];
    }

    const feedbackMatch = /^POST \/requests\/([0-9a-f-]{36})\/feedback$/.exec(route);
    if (feedbackMatch) {
      const claims = memberClaims(req);
      const body = await readJson(req);
      const event = await deps.requests.feedback(
        { type: "member", id: claims.sub },
        feedbackMatch[1]!,
        num(body, "rating"),
        typeof body.comment === "string" ? body.comment : undefined
      );
      return [201, { requestId: event.requestId, rating: (event.payload as { rating: number }).rating }];
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
    const startedAt = Date.now();
    // Access log: method/path/status/latency only — never bodies, tokens,
    // credentials, or emails (and the logger redacts by key regardless).
    const access = (status: number) =>
      logger.info("http", {
        method: req.method,
        path: (req.url ?? "/").split("?")[0],
        status,
        ms: Date.now() - startedAt,
      });
    handle(req, res)
      .then(([status, payload]) => {
        access(status);
        const raw = payload as { __raw?: string; contentType?: string };
        if (raw && typeof raw.__raw === "string") {
          res.writeHead(status, { "content-type": raw.contentType ?? "text/plain" });
          res.end(raw.__raw);
          return;
        }
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
        if (status >= 500) logger.error("api error", { name: (err as Error).name, detail: (err as Error).message });
        access(status);
        res.writeHead(status, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: message }));
      });
  });
}
