// Population guard: the single choke point where a token becomes an actor.
// A member token can never authorize as a provider or ops, and vice versa.
// Every denial is audited (hard rule 10) through an owned sink so the caller
// decides persistence (evidence event once a request exists, log otherwise).
import type { PrincipalType } from "./principals.js";
import { TokenError, verifyToken, type TokenClaims } from "./token.js";

export interface AuthDenial {
  reason: "invalid_token" | "wrong_population";
  requiredType: PrincipalType;
  /** Present only for wrong_population — who the valid token belonged to. */
  actualType?: PrincipalType;
  actualId?: string;
  occurredAt: Date;
}

export interface AuthAuditSink {
  denied(denial: AuthDenial): void;
}

export class AuthorizationError extends Error {
  constructor(public readonly denial: AuthDenial) {
    super(`authorization denied: ${denial.reason}`);
    this.name = "AuthorizationError";
  }
}

export class InMemoryAuthAuditSink implements AuthAuditSink {
  readonly denials: AuthDenial[] = [];
  denied(denial: AuthDenial): void {
    this.denials.push(denial);
  }
}

/**
 * Verify the token AND require it to belong to the given population.
 * Throws AuthorizationError (after auditing) on any failure.
 */
export function requirePrincipal(
  token: string,
  requiredType: PrincipalType,
  secret: string,
  audit: AuthAuditSink,
  now: Date = new Date()
): TokenClaims {
  let claims: TokenClaims;
  try {
    claims = verifyToken(token, secret, now);
  } catch (err) {
    if (!(err instanceof TokenError)) throw err;
    const denial: AuthDenial = { reason: "invalid_token", requiredType, occurredAt: now };
    audit.denied(denial);
    throw new AuthorizationError(denial);
  }
  if (claims.ptype !== requiredType) {
    const denial: AuthDenial = {
      reason: "wrong_population",
      requiredType,
      actualType: claims.ptype,
      actualId: claims.sub,
      occurredAt: now,
    };
    audit.denied(denial);
    throw new AuthorizationError(denial);
  }
  return claims;
}
