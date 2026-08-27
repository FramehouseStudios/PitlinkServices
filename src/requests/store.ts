// Request read-model store. Deliberately narrow: insert, conditional status
// update, and lookups. The evidence spine is the source of truth; this table
// is the queryable projection.
import type pg from "pg";
import type { RequestRecord, RequestStatus } from "./types.js";

export interface RequestStore {
  insert(record: RequestRecord): Promise<void>;
  findById(id: string): Promise<RequestRecord | null>;
  /**
   * Set status only if the current status matches `from` (optimistic,
   * idempotency-friendly). Returns true if a row was updated.
   */
  setStatus(id: string, from: RequestStatus, to: RequestStatus, at: Date): Promise<boolean>;
}

export class InMemoryRequestStore implements RequestStore {
  private byId = new Map<string, RequestRecord>();

  async insert(record: RequestRecord): Promise<void> {
    if (!this.byId.has(record.id)) this.byId.set(record.id, { ...record });
  }

  async findById(id: string): Promise<RequestRecord | null> {
    const record = this.byId.get(id);
    return record ? { ...record } : null;
  }

  async setStatus(id: string, from: RequestStatus, to: RequestStatus, at: Date): Promise<boolean> {
    const record = this.byId.get(id);
    if (!record || record.status !== from) return false;
    record.status = to;
    record.updatedAt = at;
    return true;
  }
}

interface Row {
  id: string;
  member_id: string;
  service_type: string;
  city: string;
  lat: number;
  lng: number;
  status: RequestStatus;
  created_at: Date;
  updated_at: Date;
}

function toRecord(row: Row): RequestRecord {
  return {
    id: row.id,
    memberId: row.member_id,
    serviceType: row.service_type,
    city: row.city,
    lat: row.lat,
    lng: row.lng,
    status: row.status,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export class PostgresRequestStore implements RequestStore {
  constructor(private readonly pool: pg.Pool) {}

  async insert(record: RequestRecord): Promise<void> {
    await this.pool.query(
      `INSERT INTO requests (id, member_id, service_type, city, lat, lng, status, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
       ON CONFLICT (id) DO NOTHING`,
      [record.id, record.memberId, record.serviceType, record.city, record.lat, record.lng, record.status, record.createdAt, record.updatedAt]
    );
  }

  async findById(id: string): Promise<RequestRecord | null> {
    const result = await this.pool.query<Row>("SELECT * FROM requests WHERE id = $1", [id]);
    return result.rows[0] ? toRecord(result.rows[0]) : null;
  }

  async setStatus(id: string, from: RequestStatus, to: RequestStatus, at: Date): Promise<boolean> {
    const result = await this.pool.query(
      "UPDATE requests SET status = $3, updated_at = $4 WHERE id = $1 AND status = $2",
      [id, from, to, at]
    );
    return (result.rowCount ?? 0) > 0;
  }
}
