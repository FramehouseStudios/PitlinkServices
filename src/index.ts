// Entrypoint: wires config, Postgres-backed stores, live Redis presence, the
// HTTP surface, and the WebSocket status stream.
// Run the local stack first: docker compose up -d && npm run migrate
import pg from "pg";
import { loadConfig } from "./common/config.js";
import { InMemoryAuthAuditSink } from "./common/auth/guard.js";
import { PostgresPrincipalStore } from "./common/auth/principalStore.js";
import { PostgresEvidenceStore } from "./common/evidence/postgresStore.js";
import { PostgresRequestStore } from "./requests/store.js";
import { RequestService } from "./requests/service.js";
import { MatchingEngine } from "./matching/engine.js";
import { RedisProviderPresence } from "./realtime/presence.js";
import { PresenceProviderDirectory } from "./realtime/directory.js";
import { RequestEventBus } from "./realtime/bus.js";
import { attachWs } from "./realtime/ws.js";
import { createApi } from "./api/server.js";

const config = loadConfig(process.env);
const pool = new pg.Pool({ connectionString: config.databaseUrl });
const evidence = new PostgresEvidenceStore(pool);
const bus = new RequestEventBus();
const audit = new InMemoryAuthAuditSink();

const requests = new RequestService(
  evidence,
  new PostgresRequestStore(pool),
  config.serviceTypes,
  (event) => bus.publish(event)
);

const presence = await RedisProviderPresence.connect(config.redisUrl);
export const matching = new MatchingEngine(
  new PresenceProviderDirectory(presence),
  requests,
  evidence,
  { marketplaceEnabled: config.flags.enableProviderMarketplace, onEvent: (e) => bus.publish(e) }
);

const api = createApi({
  jwtSecret: config.jwtSecret,
  jwtExpiry: config.jwtExpiry,
  defaultCity: config.defaultCity,
  members: new PostgresPrincipalStore(pool, "member"),
  requests,
  audit,
});
attachWs(api, { jwtSecret: config.jwtSecret, requests, bus, audit });

const port = Number(process.env.PORT ?? 3000);
api.listen(port, () => {
  console.log(`pitlink api+ws listening on :${port} (city: ${config.defaultCity})`);
});
