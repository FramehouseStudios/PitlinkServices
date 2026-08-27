// One store per population — no shared sessions and no shared rows. The
// implementations are parameterized by table, but each instance is bound to
// exactly one population at construction; nothing can query across them.
import type pg from "pg";
import type { Principal, PrincipalType, VerificationStatus } from "./principals.js";

export interface StoredPrincipal extends Principal {
  passwordHash: string;
  /** Providers only; members/ops are always undefined. */
  verificationStatus?: VerificationStatus;
}

export interface PrincipalStore {
  readonly type: PrincipalType;
  create(email: string, passwordHash: string): Promise<Principal>;
  findByEmail(email: string): Promise<StoredPrincipal | null>;
}

export class DuplicateEmailError extends Error {
  constructor(email: string) {
    super(`a principal with email ${email} already exists in this population`);
    this.name = "DuplicateEmailError";
  }
}

export class InMemoryPrincipalStore implements PrincipalStore {
  private byEmail = new Map<string, StoredPrincipal>();
  private nextId = 1;

  constructor(readonly type: PrincipalType) {}

  async create(email: string, passwordHash: string): Promise<Principal> {
    const key = email.toLowerCase();
    if (this.byEmail.has(key)) throw new DuplicateEmailError(email);
    const stored: StoredPrincipal = {
      type: this.type,
      id: `${this.type}-${this.nextId++}`,
      email: key,
      passwordHash,
      ...(this.type === "provider" ? { verificationStatus: "pending" as const } : {}),
    };
    this.byEmail.set(key, stored);
    const { passwordHash: _hash, verificationStatus: _status, ...principal } = stored;
    return principal;
  }

  async findByEmail(email: string): Promise<StoredPrincipal | null> {
    const stored = this.byEmail.get(email.toLowerCase());
    return stored ? { ...stored } : null;
  }
}

const TABLES: Record<PrincipalType, string> = {
  member: "members",
  provider: "providers",
  ops: "ops_users",
};

export class PostgresPrincipalStore implements PrincipalStore {
  private readonly table: string;

  constructor(private readonly pool: pg.Pool, readonly type: PrincipalType) {
    this.table = TABLES[type];
  }

  async create(email: string, passwordHash: string): Promise<Principal> {
    try {
      const result = await this.pool.query(
        `INSERT INTO ${this.table} (email, password_hash) VALUES ($1, $2) RETURNING id, email`,
        [email.toLowerCase(), passwordHash]
      );
      const row = result.rows[0] as { id: string; email: string };
      return { type: this.type, id: row.id, email: row.email };
    } catch (err) {
      if ((err as { code?: string }).code === "23505") throw new DuplicateEmailError(email);
      throw err;
    }
  }

  async findByEmail(email: string): Promise<StoredPrincipal | null> {
    const result = await this.pool.query(
      `SELECT * FROM ${this.table} WHERE email = $1`,
      [email.toLowerCase()]
    );
    const row = result.rows[0] as
      | { id: string; email: string; password_hash: string; verification_status?: VerificationStatus }
      | undefined;
    if (!row) return null;
    return {
      type: this.type,
      id: row.id,
      email: row.email,
      passwordHash: row.password_hash,
      ...(row.verification_status ? { verificationStatus: row.verification_status } : {}),
    };
  }
}
