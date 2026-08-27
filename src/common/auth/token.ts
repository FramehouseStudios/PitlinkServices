// Owned JWT implementation: HS256 only, node:crypto only. The verifier never
// reads the header to choose an algorithm — it always verifies HS256 — so
// algorithm-confusion ("alg": "none", RS256 downgrade) is structurally
// impossible rather than configured away.
import { createHmac, timingSafeEqual } from "node:crypto";
import { PRINCIPAL_TYPES, type PrincipalType } from "./principals.js";

export interface TokenClaims {
  /** subject: principal id */
  sub: string;
  /** principal population — structural isolation is enforced on this claim */
  ptype: PrincipalType;
  iat: number;
  exp: number;
}

export class TokenError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TokenError";
  }
}

const b64url = (buf: Buffer): string => buf.toString("base64url");
const hmac = (secret: string, data: string): Buffer =>
  createHmac("sha256", secret).update(data).digest();

/** Parse durations like "3600", "45s", "30m", "1h", "7d" into seconds. */
export function parseExpiry(expiry: string): number {
  const match = /^(\d+)([smhd]?)$/.exec(expiry.trim());
  if (!match) throw new TokenError(`invalid expiry ${JSON.stringify(expiry)}`);
  const value = Number(match[1]);
  const unit = { "": 1, s: 1, m: 60, h: 3600, d: 86400 }[match[2] as "" | "s" | "m" | "h" | "d"];
  const seconds = value * unit;
  if (seconds <= 0) throw new TokenError("expiry must be positive");
  return seconds;
}

export function signToken(
  principal: { id: string; type: PrincipalType },
  secret: string,
  expiry: string,
  now: Date = new Date()
): string {
  const iat = Math.floor(now.getTime() / 1000);
  const claims: TokenClaims = { sub: principal.id, ptype: principal.type, iat, exp: iat + parseExpiry(expiry) };
  const header = b64url(Buffer.from(JSON.stringify({ alg: "HS256", typ: "JWT" })));
  const payload = b64url(Buffer.from(JSON.stringify(claims)));
  const signature = b64url(hmac(secret, `${header}.${payload}`));
  return `${header}.${payload}.${signature}`;
}

export function verifyToken(token: string, secret: string, now: Date = new Date()): TokenClaims {
  const parts = token.split(".");
  if (parts.length !== 3) throw new TokenError("malformed token");
  const [header, payload, signature] = parts as [string, string, string];

  const expected = hmac(secret, `${header}.${payload}`);
  const actual = Buffer.from(signature, "base64url");
  if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) {
    throw new TokenError("invalid signature");
  }

  let claims: unknown;
  try {
    claims = JSON.parse(Buffer.from(payload, "base64url").toString());
  } catch {
    throw new TokenError("malformed claims");
  }
  const c = claims as Partial<TokenClaims>;
  if (
    typeof c.sub !== "string" ||
    !PRINCIPAL_TYPES.includes(c.ptype as PrincipalType) ||
    typeof c.iat !== "number" ||
    typeof c.exp !== "number"
  ) {
    throw new TokenError("malformed claims");
  }
  if (Math.floor(now.getTime() / 1000) >= c.exp) throw new TokenError("token expired");
  return c as TokenClaims;
}
