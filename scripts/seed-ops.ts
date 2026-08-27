// Seed an ops principal. Ops accounts are NEVER self-signup — this script is
// the only creation path. Idempotent: an existing email is left untouched.
// Usage:
//   OPS_EMAIL=you@pitlink.com OPS_PASSWORD='...' npx tsx scripts/seed-ops.ts
import pg from "pg";
import { loadConfig } from "../src/common/config.js";
import { hashPassword } from "../src/common/auth/password.js";
import { PostgresPrincipalStore, DuplicateEmailError } from "../src/common/auth/principalStore.js";

const email = process.env.OPS_EMAIL;
const password = process.env.OPS_PASSWORD;
if (!email || !password) {
  console.error("OPS_EMAIL and OPS_PASSWORD are required");
  process.exit(1);
}

const config = loadConfig(process.env);
const pool = new pg.Pool({ connectionString: config.databaseUrl });
try {
  const store = new PostgresPrincipalStore(pool, "ops");
  try {
    const ops = await store.create(email, await hashPassword(password));
    console.log(`ops principal created: ${ops.id}`);
  } catch (err) {
    if (err instanceof DuplicateEmailError) {
      console.log("ops principal already exists; nothing changed");
    } else {
      throw err;
    }
  }
} finally {
  await pool.end();
}
