// Member vehicles. Ownership is structural: every read path requires the
// member id, so one member's vehicle is invisible to another by construction.
import type pg from "pg";

export const POWERTRAINS = ["ice", "ev", "hybrid", "unknown"] as const;
export type Powertrain = (typeof POWERTRAINS)[number];

export interface Vehicle {
  id: string;
  memberId: string;
  make: string;
  model: string;
  year?: number;
  powertrain: Powertrain;
}

export interface NewVehicle {
  make: string;
  model: string;
  year?: number;
  powertrain?: Powertrain;
}

export class VehicleValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "VehicleValidationError";
  }
}

export function validateNewVehicle(input: NewVehicle): void {
  if (!input.make.trim()) throw new VehicleValidationError("make is required");
  if (!input.model.trim()) throw new VehicleValidationError("model is required");
  if (input.year !== undefined && (!Number.isInteger(input.year) || input.year < 1900 || input.year > 2100)) {
    throw new VehicleValidationError("year out of range");
  }
  if (input.powertrain !== undefined && !POWERTRAINS.includes(input.powertrain)) {
    throw new VehicleValidationError(`powertrain must be one of ${POWERTRAINS.join(", ")}`);
  }
}

export interface VehicleStore {
  create(memberId: string, input: NewVehicle): Promise<Vehicle>;
  /** Only the owner can resolve a vehicle — null otherwise. */
  findOwned(memberId: string, vehicleId: string): Promise<Vehicle | null>;
  listByMember(memberId: string): Promise<Vehicle[]>;
}

export class InMemoryVehicleStore implements VehicleStore {
  private vehicles: Vehicle[] = [];
  private nextId = 1;

  async create(memberId: string, input: NewVehicle): Promise<Vehicle> {
    validateNewVehicle(input);
    const vehicle: Vehicle = {
      id: `00000000-0000-4000-8000-${String(this.nextId++).padStart(12, "0")}`,
      memberId,
      make: input.make,
      model: input.model,
      ...(input.year !== undefined ? { year: input.year } : {}),
      powertrain: input.powertrain ?? "unknown",
    };
    this.vehicles.push(vehicle);
    return { ...vehicle };
  }

  async findOwned(memberId: string, vehicleId: string): Promise<Vehicle | null> {
    const vehicle = this.vehicles.find((v) => v.id === vehicleId && v.memberId === memberId);
    return vehicle ? { ...vehicle } : null;
  }

  async listByMember(memberId: string): Promise<Vehicle[]> {
    return this.vehicles.filter((v) => v.memberId === memberId).map((v) => ({ ...v }));
  }
}

interface Row {
  id: string;
  member_id: string;
  make: string;
  model: string;
  year: number | null;
  powertrain: Powertrain;
}

function toVehicle(row: Row): Vehicle {
  return {
    id: row.id,
    memberId: row.member_id,
    make: row.make,
    model: row.model,
    ...(row.year !== null ? { year: row.year } : {}),
    powertrain: row.powertrain,
  };
}

export class PostgresVehicleStore implements VehicleStore {
  constructor(private readonly pool: pg.Pool) {}

  async create(memberId: string, input: NewVehicle): Promise<Vehicle> {
    validateNewVehicle(input);
    const result = await this.pool.query<Row>(
      `INSERT INTO vehicles (member_id, make, model, year, powertrain)
       VALUES ($1, $2, $3, $4, $5) RETURNING *`,
      [memberId, input.make, input.model, input.year ?? null, input.powertrain ?? "unknown"]
    );
    return toVehicle(result.rows[0]!);
  }

  async findOwned(memberId: string, vehicleId: string): Promise<Vehicle | null> {
    const result = await this.pool.query<Row>(
      "SELECT * FROM vehicles WHERE id = $1 AND member_id = $2",
      [vehicleId, memberId]
    );
    return result.rows[0] ? toVehicle(result.rows[0]) : null;
  }

  async listByMember(memberId: string): Promise<Vehicle[]> {
    const result = await this.pool.query<Row>(
      "SELECT * FROM vehicles WHERE member_id = $1 ORDER BY created_at",
      [memberId]
    );
    return result.rows.map(toVehicle);
  }
}
