-- 004: Vehicles (member bounded context) + optional vehicle on a request.
-- PII minimization: no plate, no VIN until a feature genuinely needs them.
-- powertrain drives triage (an EV out of charge is not a fuel delivery).

CREATE TABLE IF NOT EXISTS vehicles (
  id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  member_id  UUID NOT NULL,
  make       TEXT NOT NULL,
  model      TEXT NOT NULL,
  year       INTEGER,
  powertrain TEXT NOT NULL DEFAULT 'unknown'
    CHECK (powertrain IN ('ice', 'ev', 'hybrid', 'unknown')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS vehicles_member_id_idx ON vehicles (member_id);

ALTER TABLE requests ADD COLUMN IF NOT EXISTS vehicle_id UUID;
