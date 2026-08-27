// Central env-driven configuration. Commercial decisions (city, flags, vendor
// keys) are configuration, never code constants. Missing required values fail
// loudly at startup rather than surfacing as runtime defects later.

export interface AppConfig {
  databaseUrl: string;
  redisUrl: string;
  jwtSecret: string;
  jwtExpiry: string;
  defaultCity: string;
  flags: {
    enablePredictiveAlerts: boolean;
    enableProviderMarketplace: boolean;
  };
  vendors: {
    openaiApiKey?: string;
    mapboxAccessToken?: string;
    stripeSecretKey?: string;
    stripeWebhookSecret?: string;
  };
}

export class ConfigError extends Error {
  constructor(missing: string[]) {
    super(`Missing required environment variables: ${missing.join(", ")}`);
    this.name = "ConfigError";
  }
}

const REQUIRED = ["DATABASE_URL", "REDIS_URL", "JWT_SECRET", "JWT_EXPIRY", "DEFAULT_CITY"] as const;

function parseBool(value: string | undefined, name: string): boolean {
  if (value === "true") return true;
  if (value === "false") return false;
  throw new ConfigError([`${name} (must be "true" or "false", got ${JSON.stringify(value)})`]);
}

export function loadConfig(env: NodeJS.ProcessEnv): AppConfig {
  const missing = REQUIRED.filter((key) => !env[key]);
  if (missing.length > 0) throw new ConfigError([...missing]);

  return {
    databaseUrl: env.DATABASE_URL!,
    redisUrl: env.REDIS_URL!,
    jwtSecret: env.JWT_SECRET!,
    jwtExpiry: env.JWT_EXPIRY!,
    defaultCity: env.DEFAULT_CITY!,
    flags: {
      enablePredictiveAlerts: parseBool(env.ENABLE_PREDICTIVE_ALERTS, "ENABLE_PREDICTIVE_ALERTS"),
      enableProviderMarketplace: parseBool(
        env.ENABLE_PROVIDER_MARKETPLACE,
        "ENABLE_PROVIDER_MARKETPLACE"
      ),
    },
    vendors: {
      ...(env.OPENAI_API_KEY ? { openaiApiKey: env.OPENAI_API_KEY } : {}),
      ...(env.MAPBOX_ACCESS_TOKEN ? { mapboxAccessToken: env.MAPBOX_ACCESS_TOKEN } : {}),
      ...(env.STRIPE_SECRET_KEY ? { stripeSecretKey: env.STRIPE_SECRET_KEY } : {}),
      ...(env.STRIPE_WEBHOOK_SECRET ? { stripeWebhookSecret: env.STRIPE_WEBHOOK_SECRET } : {}),
    },
  };
}
