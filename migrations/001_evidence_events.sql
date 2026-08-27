-- 001: Append-only evidence spine.
-- Every metric-affecting state change emits a row here BEFORE side effects.
-- Corrections are compensating records; UPDATE/DELETE are forbidden at the DB layer.

CREATE TABLE IF NOT EXISTS evidence_events (
  id                        BIGSERIAL PRIMARY KEY,
  request_id                UUID        NOT NULL,
  event_type                TEXT        NOT NULL,
  payload                   JSONB       NOT NULL DEFAULT '{}'::jsonb,
  -- Structural identity separation: the actor population is explicit on every event.
  actor_type                TEXT        NOT NULL CHECK (actor_type IN ('member', 'provider', 'ops', 'system')),
  actor_id                  TEXT        NOT NULL,
  -- Metrics must be reproducible: every event carries the version of the
  -- calculation rules in force when it was recorded.
  calculation_rules_version TEXT        NOT NULL,
  -- Exactly-once effect on ingestion paths.
  idempotency_key           TEXT        NOT NULL UNIQUE,
  occurred_at               TIMESTAMPTZ NOT NULL,
  recorded_at               TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS evidence_events_request_id_idx
  ON evidence_events (request_id, occurred_at);
CREATE INDEX IF NOT EXISTS evidence_events_event_type_idx
  ON evidence_events (event_type);

-- Append-only is structural, not conventional: reject UPDATE and DELETE in the DB.
CREATE OR REPLACE FUNCTION forbid_evidence_mutation() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'evidence_events is append-only; write a compensating event instead';
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS evidence_events_no_mutation ON evidence_events;
CREATE TRIGGER evidence_events_no_mutation
  BEFORE UPDATE OR DELETE ON evidence_events
  FOR EACH ROW EXECUTE FUNCTION forbid_evidence_mutation();
