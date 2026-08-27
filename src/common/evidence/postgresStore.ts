import type pg from "pg";
import type { EvidenceStore } from "./store.js";
import { validateNewEvent, type ActorType, type EvidenceEvent, type NewEvidenceEvent } from "./types.js";

interface Row {
  id: string;
  request_id: string;
  event_type: string;
  payload: Record<string, unknown>;
  actor_type: ActorType;
  actor_id: string;
  calculation_rules_version: string;
  idempotency_key: string;
  occurred_at: Date;
  recorded_at: Date;
}

function toEvent(row: Row): EvidenceEvent {
  return {
    id: Number(row.id),
    requestId: row.request_id,
    eventType: row.event_type,
    payload: row.payload,
    actorType: row.actor_type,
    actorId: row.actor_id,
    calculationRulesVersion: row.calculation_rules_version,
    idempotencyKey: row.idempotency_key,
    occurredAt: row.occurred_at,
    recordedAt: row.recorded_at,
  };
}

export class PostgresEvidenceStore implements EvidenceStore {
  constructor(private readonly pool: pg.Pool) {}

  async append(event: NewEvidenceEvent): Promise<EvidenceEvent> {
    validateNewEvent(event);
    // ON CONFLICT DO NOTHING + follow-up select gives exactly-once semantics:
    // a replayed idempotencyKey returns the original event untouched.
    const inserted = await this.pool.query<Row>(
      `INSERT INTO evidence_events
         (request_id, event_type, payload, actor_type, actor_id,
          calculation_rules_version, idempotency_key, occurred_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
       ON CONFLICT (idempotency_key) DO NOTHING
       RETURNING *`,
      [
        event.requestId,
        event.eventType,
        JSON.stringify(event.payload),
        event.actorType,
        event.actorId,
        event.calculationRulesVersion,
        event.idempotencyKey,
        event.occurredAt,
      ]
    );
    const row = inserted.rows[0];
    if (row) return toEvent(row);

    const existing = await this.pool.query<Row>(
      "SELECT * FROM evidence_events WHERE idempotency_key = $1",
      [event.idempotencyKey]
    );
    const existingRow = existing.rows[0];
    if (!existingRow) {
      throw new Error("evidence append conflict: idempotency key vanished mid-append");
    }
    return toEvent(existingRow);
  }

  async timeline(requestId: string): Promise<EvidenceEvent[]> {
    const result = await this.pool.query<Row>(
      "SELECT * FROM evidence_events WHERE request_id = $1 ORDER BY occurred_at, id",
      [requestId]
    );
    return result.rows.map(toEvent);
  }
}
