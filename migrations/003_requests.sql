-- 003: Request bounded context. The status column is a read-model convenience;
-- the evidence spine (001) remains the source of truth for the lifecycle.
-- service_type is TEXT, not an enum: the service catalog is configuration
-- (pricing/packaging per type is an open commercial decision).

CREATE TABLE IF NOT EXISTS requests (
  id           UUID PRIMARY KEY,
  member_id    UUID NOT NULL,
  service_type TEXT NOT NULL,
  city         TEXT NOT NULL,
  lat          DOUBLE PRECISION NOT NULL,
  lng          DOUBLE PRECISION NOT NULL,
  status       TEXT NOT NULL CHECK (status IN
    ('created', 'triaged', 'matched', 'en_route', 'on_scene', 'resolved', 'closed', 'cancelled')),
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS requests_member_id_idx ON requests (member_id, created_at);
CREATE INDEX IF NOT EXISTS requests_status_idx ON requests (status);
