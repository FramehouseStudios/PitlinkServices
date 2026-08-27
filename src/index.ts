// Entrypoint: wires config, Postgres-backed stores, live Redis presence, the
// HTTP surface, and the WebSocket status stream.
// Run the local stack first: docker compose up -d && npm run migrate
import pg from "pg";
import { fileURLToPath } from "node:url";
import { loadConfig } from "./common/config.js";
import { InMemoryAuthAuditSink } from "./common/auth/guard.js";
import { PostgresPrincipalStore } from "./common/auth/principalStore.js";
import { PostgresVehicleStore } from "./members/vehicles.js";
import { PostgresEvidenceStore } from "./common/evidence/postgresStore.js";
import { PostgresRequestStore } from "./requests/store.js";
import { RequestService } from "./requests/service.js";
import { MatchingEngine } from "./matching/engine.js";
import { RedisProviderPresence } from "./realtime/presence.js";
import { PresenceProviderDirectory } from "./realtime/directory.js";
import { RequestEventBus } from "./realtime/bus.js";
import { attachWs } from "./realtime/ws.js";
import { TrackingService } from "./realtime/tracking.js";
import { createApi } from "./api/server.js";
import { Logger } from "./common/logger.js";
import { DEFAULT_POLICY, ReliabilityService } from "./reliability/service.js";
import { DEFAULT_REPUTATION_POLICY, ReputationService } from "./reliability/reputation.js";

const config = loadConfig(process.env);
const pool = new pg.Pool({ connectionString: config.databaseUrl });
const evidence = new PostgresEvidenceStore(pool);
const bus = new RequestEventBus();
const audit = new InMemoryAuthAuditSink();

const requests = new RequestService(
  evidence,
  new PostgresRequestStore(pool),
  config.serviceTypes,
  (event) => {
    bus.publish(event);
    // Phase 0 orchestration: a new request is auto-triaged and matched
    // in-process (the conversational agent takes over triage once LLM
    // routing is decided). A failed match stays measurable on the spine.
    if (event.eventType === "request.created") {
      setImmediate(async () => {
        try {
          await requests.transition({ type: "system", id: "auto-triage" }, event.requestId, "triaged", `auto:${event.requestId}`);
          await matching.match(event.requestId, `auto:${event.requestId}`);
        } catch (err) {
          logger.error("auto-flow failed", { requestId: event.requestId, detail: (err as Error).message });
        }
      });
    }
  }
);

const num = (name: string, fallback: number): number => {
  const raw = process.env[name];
  const parsed = raw === undefined ? NaN : Number(raw);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
};

const reputation = new ReputationService(requests, {
  minAssignments: num("REPUTATION_MIN_ASSIGNMENTS", DEFAULT_REPUTATION_POLICY.minAssignments),
  maxNoShowRate: num("REPUTATION_MAX_NO_SHOW_RATE", DEFAULT_REPUTATION_POLICY.maxNoShowRate),
  minRatings: num("REPUTATION_MIN_RATINGS", DEFAULT_REPUTATION_POLICY.minRatings),
  minAvgRating: num("REPUTATION_MIN_AVG_RATING", DEFAULT_REPUTATION_POLICY.minAvgRating),
});
await reputation.refresh();

const presence = await RedisProviderPresence.connect(config.redisUrl);
export const matching = new MatchingEngine(
  new PresenceProviderDirectory(presence),
  requests,
  evidence,
  {
    marketplaceEnabled: config.flags.enableProviderMarketplace,
    onEvent: (e) => bus.publish(e),
    isSuppressed: (id) => reputation.isSuppressed(id),
  }
);

const logger = new Logger({ app: "pitlink" });

// Service reliability: retry unmatched requests, recover no-shows, escalate
// silence. Runs in-process on an interval — a cron/worker split is a
// measured trigger (Blueprint §13), not a day-one requirement.
const reliability = new ReliabilityService(
  requests,
  matching,
  evidence,
  {
    rematchIntervalSeconds: num("RELIABILITY_REMATCH_SECONDS", DEFAULT_POLICY.rematchIntervalSeconds),
    unmatchedEscalationSeconds: num("RELIABILITY_ESCALATE_SECONDS", DEFAULT_POLICY.unmatchedEscalationSeconds),
    acceptToEnRouteSeconds: num("RELIABILITY_START_SECONDS", DEFAULT_POLICY.acceptToEnRouteSeconds),
    enRouteToArrivalSeconds: num("RELIABILITY_ARRIVAL_SECONDS", DEFAULT_POLICY.enRouteToArrivalSeconds),
    batchSize: num("RELIABILITY_BATCH", DEFAULT_POLICY.batchSize),
  },
  (e) => bus.publish(e)
);
const sweepSeconds = Number(process.env.RELIABILITY_SWEEP_SECONDS ?? 30);
const sweepTimer = setInterval(() => {
  void reputation.refreshIfStale();
  reliability
    .sweep()
    .then((report) => {
      if (report.rematched || report.noShowsRecovered || report.escalated) {
        logger.warn("reliability sweep acted", { ...report });
      }
    })
    .catch((err: Error) => logger.error("reliability sweep failed", { detail: err.message }));
}, sweepSeconds * 1000);
sweepTimer.unref();

const api = createApi({
  jwtSecret: config.jwtSecret,
  jwtExpiry: config.jwtExpiry,
  defaultCity: config.defaultCity,
  serviceTypes: config.serviceTypes,
  webAppPath: fileURLToPath(new URL("../public/index.html", import.meta.url)),
  providerAppPath: fileURLToPath(new URL("../public/provider.html", import.meta.url)),
  members: new PostgresPrincipalStore(pool, "member"),
  providers: new PostgresPrincipalStore(pool, "provider"),
  ops: new PostgresPrincipalStore(pool, "ops"),
  vehicles: new PostgresVehicleStore(pool),
  requests,
  reliability,
  reputation,
  presence,
  tracking: new TrackingService(evidence, requests, {}, (e) => bus.publish(e)),
  audit,
  logger,
  healthChecks: {
    postgres: async () => {
      await pool.query("SELECT 1");
    },
    redis: async () => {
      // A zero-TTL-safe probe: reading candidates exercises the connection.
      await presence.candidates("__health__", "__health__");
    },
  },
});
attachWs(api, { jwtSecret: config.jwtSecret, requests, bus, audit });

const port = Number(process.env.PORT ?? 3000);
api.listen(port, () => {
  logger.info("listening", { port, city: config.defaultCity });
});
