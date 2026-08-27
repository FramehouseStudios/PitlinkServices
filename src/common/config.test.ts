import { describe, expect, it } from "vitest";
import { ConfigError, loadConfig } from "./config.js";

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
