// Entrypoint: wires config, Postgres-backed stores, and the HTTP surface.
// Run the local stack first: docker compose up -d && npm run migrate
import pg from "pg";
import { loadConfig } from "./common/config.js";
import { InMemoryAuthAuditSink } from "./common/auth/guard.js";
import { PostgresPrincipalStore } from "./common/auth/principalStore.js";
import { PostgresEvidenceStore } from "./common/evidence/postgresStore.js";
import { PostgresRequestStore } from "./requests/store.js";
import { RequestService } from "./requests/service.js";
import { createApi } from "./api/server.js";

const config = loadConfig(process.env);
const pool = new pg.Pool({ connectionString: config.databaseUrl });

const api = createApi({
  jwtSecret: config.jwtSecret,
  jwtExpiry: config.jwtExpiry,
  defaultCity: config.defaultCity,
  members: new PostgresPrincipalStore(pool, "member"),
  requests: new RequestService(
    new PostgresEvidenceStore(pool),
    new PostgresRequestStore(pool),
    config.serviceTypes
  ),
  audit: new InMemoryAuthAuditSink(),
});

const port = Number(process.env.PORT ?? 3000);
api.listen(port, () => {
  console.log(`pitlink api listening on :${port} (city: ${config.defaultCity})`);
});
