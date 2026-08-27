import { describe, expect, it } from "vitest";
import { ConfigError, InsecureConfigError, loadConfig } from "./config.js";

const VALID_ENV = {
  DATABASE_URL: "postgres://pitlink:pitlink@localhost:5432/pitlink",
  REDIS_URL: "redis://localhost:6379",
  JWT_SECRET: "test-secret",
  JWT_EXPIRY: "1h",
  DEFAULT_CITY: "los-angeles",
  ENABLE_PREDICTIVE_ALERTS: "false",
  ENABLE_PROVIDER_MARKETPLACE: "true",
};

describe("config", () => {
  it("loads decided values from env, never from code", () => {
    const config = loadConfig({ ...VALID_ENV });
    expect(config.defaultCity).toBe("los-angeles");
    expect(config.flags.enablePredictiveAlerts).toBe(false);
    expect(config.flags.enableProviderMarketplace).toBe(true);
  });

  it("failure mode: fails loudly when required variables are missing", () => {
    const { DATABASE_URL: _omitted, ...withoutDb } = VALID_ENV;
    expect(() => loadConfig(withoutDb)).toThrow(ConfigError);
    expect(() => loadConfig(withoutDb)).toThrow(/DATABASE_URL/);
  });

  it("failure mode: rejects ambiguous feature-flag values", () => {
    expect(() => loadConfig({ ...VALID_ENV, ENABLE_PROVIDER_MARKETPLACE: "yes" })).toThrow(ConfigError);
    expect(() => loadConfig({ ...VALID_ENV, ENABLE_PREDICTIVE_ALERTS: undefined })).toThrow(ConfigError);
  });
});

describe("production hardening", () => {
  const strong = "Kq7Zx2Pm9Lw4Rt6Yv8Bn3Cd5Fg1Hj0Ak2Ms4Nq6Pr8Tv";
  const prod = { ...VALID_ENV, NODE_ENV: "production", JWT_SECRET: strong };

  it("starts in production with a strong secret", () => {
    const config = loadConfig(prod);
    expect(config.environment).toBe("production");
  });

  it("development is permissive — a weak local secret is fine", () => {
    expect(loadConfig({ ...VALID_ENV, JWT_SECRET: "local" }).environment).toBe("development");
  });

  it("SECURITY: production refuses to start on a weak or placeholder JWT secret", () => {
    // Too short.
    expect(() => loadConfig({ ...prod, JWT_SECRET: "short-secret" })).toThrow(InsecureConfigError);
    // Long enough but a known placeholder.
    expect(() => loadConfig({ ...prod, JWT_SECRET: "change-me-change-me-change-me-change-me" })).toThrow(
      /placeholder/
    );
    expect(() => loadConfig({ ...prod, JWT_SECRET: "correct-horse-battery-password-stapler" })).toThrow(
      /placeholder/
    );
    // No entropy.
    expect(() => loadConfig({ ...prod, JWT_SECRET: "a".repeat(48) })).toThrow(/entropy/);
    // The error tells the operator exactly how to fix it.
    expect(() => loadConfig({ ...prod, JWT_SECRET: "short" })).toThrow(/openssl rand/);
  });
});
