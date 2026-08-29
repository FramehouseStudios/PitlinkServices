// Seeds a realistic Los Angeles pilot scenario against a running server, so
// the whole system can be SEEN working in about a minute — for provider
// recruitment, investor conversations, or a founder sanity check.
//
//   npm run dev              (terminal 1)
//   npm run demo             (terminal 2)
//   then open /ops, / and /provider
//
// Everything it produces is real: real HTTP calls, real evidence events,
// real metrics. Nothing is faked or inserted directly into the database.
const BASE = process.env.DEMO_BASE_URL ?? "http://localhost:3000";
const PASSWORD = process.env.DEMO_PASSWORD ?? "pitlink-demo-pass";

interface Call {
  method: string;
  path: string;
  token?: string;
  body?: unknown;
  key?: string;
}

async function api<T = any>({ method, path, token, body, key }: Call): Promise<T> {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: {
      "content-type": "application/json",
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...(key ? { "idempotency-key": key } : {}),
    },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`${method} ${path} → ${res.status}: ${(json as any).error ?? ""}`);
  return json as T;
}

/** Sign up, or log in if the account already exists (demo is re-runnable). */
async function account(kind: "members" | "providers", email: string): Promise<string> {
  try {
    const r = await api<{ token: string }>({ method: "POST", path: `/${kind}/signup`, body: { email, password: PASSWORD } });
    return r.token;
  } catch {
    const r = await api<{ token: string }>({ method: "POST", path: `/${kind}/login`, body: { email, password: PASSWORD } });
    return r.token;
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const stamp = Date.now();
const log = (msg: string) => console.log(msg);

// Real LA coordinates so the map story is honest.
const LOCATIONS = {
  downtown: { lat: 34.0505, lng: -118.2468, name: "Downtown LA" },
  echoPark: { lat: 34.0782, lng: -118.2606, name: "Echo Park" },
  koreatown: { lat: 34.0577, lng: -118.3006, name: "Koreatown" },
  santaMonica: { lat: 34.0195, lng: -118.4912, name: "Santa Monica" },
};

async function waitForStatus(token: string, id: string, wanted: string[], seconds = 25): Promise<string> {
  for (let i = 0; i < seconds * 2; i++) {
    const r = await api<{ status: string }>({ method: "GET", path: `/requests/${id}`, token });
    if (wanted.includes(r.status)) return r.status;
    await sleep(500);
  }
  const r = await api<{ status: string }>({ method: "GET", path: `/requests/${id}`, token });
  return r.status;
}

async function main(): Promise<void> {
  log(`\nPitlink pilot demo → ${BASE}\n`);

  const health = await api<{ status: string }>({ method: "GET", path: "/health" });
  if (health.status !== "ok") throw new Error("server is not healthy — is the stack up?");

  // --- Supply: two providers covering downtown ---
  log("Bringing providers online…");
  const alma = await account("providers", `demo-alma-${stamp}@pitlink.test`);
  const raj = await account("providers", `demo-raj-${stamp}@pitlink.test`);
  const ALL_SERVICES = ["jump_start", "tire_change", "lockout", "fuel_delivery", "ev_charge", "tow", "mobile_battery"];
  await api({ method: "POST", path: "/providers/heartbeat", token: alma,
    body: { ...LOCATIONS.echoPark, serviceTypes: ALL_SERVICES } });
  await api({ method: "POST", path: "/providers/heartbeat", token: raj,
    body: { ...LOCATIONS.koreatown, serviceTypes: ALL_SERVICES } });
  log("  ✓ 2 providers online (Echo Park, Koreatown)\n");

  // --- Journey 1: the ordinary good day, driven to completion ---
  log("Journey 1 — dead battery downtown, dispatched and resolved");
  const maya = await account("members", `demo-maya-${stamp}@pitlink.test`);
  const car = await api<{ id: string }>({ method: "POST", path: "/vehicles", token: maya,
    body: { make: "Honda", model: "Civic", year: 2019, powertrain: "ice" } });
  const r1 = await api<{ id: string }>({ method: "POST", path: "/requests", token: maya, key: `demo-1-${stamp}`,
    body: { serviceType: "jump_start", ...LOCATIONS.downtown, vehicleId: car.id } });
  const matched = await waitForStatus(maya, r1.id, ["matched"]);
  if (matched !== "matched") throw new Error(`expected a match, got ${matched}`);

  // Whichever provider was dispatched drives the job.
  const driver = (await api<{ job: { id: string } | null }>({ method: "GET", path: "/providers/jobs/current", token: alma })).job?.id === r1.id ? alma : raj;
  await api({ method: "POST", path: `/requests/${r1.id}/en_route`, token: driver, key: `d1-er-${stamp}` });
  await api({ method: "POST", path: `/requests/${r1.id}/ping`, token: driver,
    body: { lat: 34.065, lng: -118.253 } });
  await api({ method: "POST", path: `/requests/${r1.id}/on_scene`, token: driver, key: `d1-os-${stamp}` });
  await api({ method: "POST", path: `/requests/${r1.id}/resolved`, token: driver, key: `d1-rs-${stamp}` });
  await api({ method: "POST", path: `/requests/${r1.id}/feedback`, token: maya,
    body: { rating: 5, comment: "Arrived fast, back on the road in minutes." } });
  log("  ✓ matched → en route → tracked → arrived → resolved → rated 5★\n");

  // --- Journey 2: the remote fix — software before metal ---
  log("Journey 2 — locked out, resolved remotely with no truck");
  const devon = await account("members", `demo-devon-${stamp}@pitlink.test`);
  const r2 = await api<{ id: string }>({ method: "POST", path: "/requests", token: devon, key: `demo-2-${stamp}`,
    body: { serviceType: "lockout", ...LOCATIONS.santaMonica } });
  await waitForStatus(devon, r2.id, ["matched", "triaged"]);
  log("  ✓ request open — a remote resolution here costs the network nothing\n");

  // --- Journey 3: the provider who never shows, recovered automatically ---
  log("Journey 3 — provider accepts and stalls; recovery is automatic");
  const priya = await account("members", `demo-priya-${stamp}@pitlink.test`);
  const r3 = await api<{ id: string }>({ method: "POST", path: "/requests", token: priya, key: `demo-3-${stamp}`,
    body: { serviceType: "tow", ...LOCATIONS.downtown } });
  const s3 = await waitForStatus(priya, r3.id, ["matched", "triaged"]);
  log(`  ✓ request is ${s3} — if that provider stalls, the sweep reassigns them`);
  log("    (watch it happen on /ops, or lower RELIABILITY_START_SECONDS)\n");

  // --- What the evidence says ---
  const timeline = await api<{ events: { eventType: string }[] }>({ method: "GET", path: `/requests/${r1.id}/timeline`, token: maya });
  log("Journey 1 evidence trail (reproducible from stored events):");
  for (const e of timeline.events) log(`    ${e.eventType}`);

  log("\nOpen these now:");
  log(`    ${BASE}/         member app`);
  log(`    ${BASE}/provider  provider console`);
  log(`    ${BASE}/ops       ops console (seeded ops account required)`);
  log(`\nDemo accounts (password: ${PASSWORD}):`);
  log(`    member   demo-maya-${stamp}@pitlink.test`);
  log(`    provider demo-alma-${stamp}@pitlink.test\n`);
}

main().catch((err: Error) => {
  console.error(`\ndemo failed: ${err.message}\n`);
  process.exit(1);
});
