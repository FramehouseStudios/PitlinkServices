import { describe, expect, it } from "vitest";
import { hashPassword, verifyPassword } from "./password.js";
import { parseExpiry, signToken, TokenError, verifyToken } from "./token.js";
import { AuthorizationError, InMemoryAuthAuditSink, requirePrincipal } from "./guard.js";
import { DuplicateEmailError, InMemoryPrincipalStore } from "./principalStore.js";

const SECRET = "test-secret";
const NOW = new Date("2026-08-26T12:00:00Z");

describe("password hashing", () => {
  it("verifies the right password and rejects the wrong one", async () => {
    const hash = await hashPassword("correct-horse");
    expect(await verifyPassword("correct-horse", hash)).toBe(true);
    expect(await verifyPassword("wrong-horse", hash)).toBe(false);
  });

  it("salts: same password twice produces different hashes", async () => {
    expect(await hashPassword("correct-horse")).not.toBe(await hashPassword("correct-horse"));
  });

  it("failure mode: rejects short passwords and garbage stored hashes", async () => {
    await expect(hashPassword("short")).rejects.toThrow(/at least 8/);
    expect(await verifyPassword("anything", "not-a-hash")).toBe(false);
    expect(await verifyPassword("anything", "bcrypt$whatever$x$y$z$w")).toBe(false);
  });
});

describe("token service", () => {
  it("round-trips claims for each population", () => {
    for (const type of ["member", "provider", "ops"] as const) {
      const token = signToken({ id: `${type}-1`, type }, SECRET, "1h", NOW);
      const claims = verifyToken(token, SECRET, NOW);
      expect(claims.sub).toBe(`${type}-1`);
      expect(claims.ptype).toBe(type);
    }
  });

  it("parses expiry formats", () => {
    expect(parseExpiry("3600")).toBe(3600);
    expect(parseExpiry("45s")).toBe(45);
    expect(parseExpiry("30m")).toBe(1800);
    expect(parseExpiry("1h")).toBe(3600);
    expect(parseExpiry("7d")).toBe(604800);
    expect(() => parseExpiry("soon")).toThrow(TokenError);
    expect(() => parseExpiry("0")).toThrow(TokenError);
  });

  it("failure mode: rejects expired tokens", () => {
    const token = signToken({ id: "member-1", type: "member" }, SECRET, "1h", NOW);
    const later = new Date(NOW.getTime() + 3601 * 1000);
    expect(() => verifyToken(token, SECRET, later)).toThrow(/expired/);
  });

  it("adversarial: rejects tampered payloads and signatures", () => {
    const token = signToken({ id: "member-1", type: "member" }, SECRET, "1h", NOW);
    const [header, , signature] = token.split(".") as [string, string, string];
    // Forge an ops claim, keep the member signature.
    const forgedPayload = Buffer.from(
      JSON.stringify({ sub: "member-1", ptype: "ops", iat: 0, exp: 9999999999 })
    ).toString("base64url");
    expect(() => verifyToken(`${header}.${forgedPayload}.${signature}`, SECRET, NOW)).toThrow(/signature/);
    // Wrong secret.
    expect(() => verifyToken(token, "other-secret", NOW)).toThrow(/signature/);
  });

  it("adversarial: alg confusion is structurally impossible", () => {
    // A classic "alg": "none" token with an empty signature must die on the
    // signature check — the verifier never consults the header's alg.
    const header = Buffer.from(JSON.stringify({ alg: "none", typ: "JWT" })).toString("base64url");
    const payload = Buffer.from(
      JSON.stringify({ sub: "member-1", ptype: "ops", iat: 0, exp: 9999999999 })
    ).toString("base64url");
    expect(() => verifyToken(`${header}.${payload}.`, SECRET, NOW)).toThrow(/signature/);
    expect(() => verifyToken("garbage", SECRET, NOW)).toThrow(/malformed/);
  });
});

describe("population guard", () => {
  it("admits the right population", () => {
    const audit = new InMemoryAuthAuditSink();
    const token = signToken({ id: "provider-1", type: "provider" }, SECRET, "1h", NOW);
    const claims = requirePrincipal(token, "provider", SECRET, audit, NOW);
    expect(claims.sub).toBe("provider-1");
    expect(audit.denials).toHaveLength(0);
  });

  it("adversarial: a member token can never authorize as provider or ops, and the denial is audited", () => {
    const audit = new InMemoryAuthAuditSink();
    const memberToken = signToken({ id: "member-1", type: "member" }, SECRET, "1h", NOW);
    for (const target of ["provider", "ops"] as const) {
      expect(() => requirePrincipal(memberToken, target, SECRET, audit, NOW)).toThrow(AuthorizationError);
    }
    expect(audit.denials).toHaveLength(2);
    expect(audit.denials[0]).toMatchObject({
      reason: "wrong_population",
      requiredType: "provider",
      actualType: "member",
      actualId: "member-1",
    });
  });

  it("failure mode: invalid tokens are denied and audited without leaking claims", () => {
    const audit = new InMemoryAuthAuditSink();
    expect(() => requirePrincipal("not.a.token", "member", SECRET, audit, NOW)).toThrow(AuthorizationError);
    expect(audit.denials).toMatchObject([{ reason: "invalid_token", requiredType: "member" }]);
    expect(audit.denials[0]).not.toHaveProperty("actualId");
  });
});

describe("principal stores", () => {
  it("populations are isolated: same email may exist in each store, never twice in one", async () => {
    const members = new InMemoryPrincipalStore("member");
    const providers = new InMemoryPrincipalStore("provider");
    await members.create("sam@example.com", "hash");
    await providers.create("sam@example.com", "hash");
    await expect(members.create("SAM@example.com", "hash")).rejects.toThrow(DuplicateEmailError);
    expect((await members.findByEmail("sam@example.com"))?.type).toBe("member");
    expect((await providers.findByEmail("sam@example.com"))?.type).toBe("provider");
  });

  it("providers start unverified; members carry no verification field", async () => {
    const providers = new InMemoryPrincipalStore("provider");
    const members = new InMemoryPrincipalStore("member");
    await providers.create("p@example.com", "hash");
    await members.create("m@example.com", "hash");
    expect((await providers.findByEmail("p@example.com"))?.verificationStatus).toBe("pending");
    expect((await members.findByEmail("m@example.com"))?.verificationStatus).toBeUndefined();
  });
});
