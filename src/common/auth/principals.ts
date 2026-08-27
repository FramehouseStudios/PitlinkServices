// Principal populations. Deliberately mirrors the evidence spine's actor
// types minus "system" (system is not an authenticatable principal).

export const PRINCIPAL_TYPES = ["member", "provider", "ops"] as const;
export type PrincipalType = (typeof PRINCIPAL_TYPES)[number];

export interface Principal {
  type: PrincipalType;
  id: string;
  email: string;
}

export type VerificationStatus = "pending" | "verified" | "rejected";
