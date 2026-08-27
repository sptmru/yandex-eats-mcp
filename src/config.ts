import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { z } from "zod";

const booleanString = z
  .enum(["true", "false", "1", "0", "yes", "no"])
  .transform((value) => value === "true" || value === "1" || value === "yes");

const optionalNumber = z.preprocess(
  (value) => (value === "" || value === undefined ? undefined : value),
  z.coerce.number().finite().optional(),
);

const envSchema = z
  .object({
    NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
    HOST: z.string().default("0.0.0.0"),
    PORT: z.coerce.number().int().min(1).max(65535).default(3000),
    LOG_LEVEL: z.enum(["fatal", "error", "warn", "info", "debug", "trace", "silent"]).default("info"),
    PUBLIC_BASE_URL: z.string().url().optional(),
    MCP_AUTH_MODE: z.enum(["oauth", "bearer", "none"]).default("oauth"),
    MCP_OAUTH_PASSWORD_FILE: z.string().default("/run/secrets/mcp_oauth_password"),
    MCP_BEARER_TOKEN_FILE: z.string().default("/run/secrets/mcp_bearer_token"),
    MCP_STATE_DIR: z.string().default("./state"),
    YANDEX_EATS_BASE_URL: z.string().url().default("https://eats.yandex.com"),
    YANDEX_EATS_COOKIE_FILE: z.string().default("/run/secrets/yandex_eats_cookie"),
    YANDEX_EATS_LOCALE: z.string().min(2).default("ru"),
    YANDEX_EATS_PLATFORM: z.string().default("desktop_web"),
    YANDEX_EATS_APP_VERSION: z.string().default("18.43.3"),
    YANDEX_EATS_LATITUDE: optionalNumber,
    YANDEX_EATS_LONGITUDE: optionalNumber,
    YANDEX_EATS_CITY: z.string().optional(),
    YANDEX_EATS_ADDRESS_LABEL: z.string().optional(),
    YANDEX_EATS_SHIPPING_TYPE: z.literal("delivery").default("delivery"),
    YANDEX_EATS_TIMEOUT_MS: z.coerce.number().int().min(1_000).max(60_000).default(15_000),
    YANDEX_EATS_ENABLE_MUTATIONS: booleanString.default(false),
    YANDEX_EATS_MAX_SEARCH_PLACES: z.coerce.number().int().min(1).max(50).default(10),
    YANDEX_EATS_MAX_ITEMS_PER_PLACE: z.coerce.number().int().min(1).max(25).default(5),
    YANDEX_EATS_ENABLE_ORDER_MONITORING: booleanString.default(false),
    YANDEX_EATS_ORDER_POLL_MIN_MS: z.coerce.number().int().min(1_000).max(60_000).default(2_000),
    YANDEX_EATS_ORDER_POLL_MAX_MS: z.coerce.number().int().min(2_000).max(300_000).default(60_000),
    YANDEX_EATS_ORDER_ERROR_BACKOFF_MAX_MS: z.coerce.number().int().min(10_000).max(600_000).default(120_000),
    YANDEX_EATS_ORDER_EVENT_RETENTION_DAYS: z.coerce.number().int().min(1).max(365).default(30),
    YANDEX_EATS_ORDER_EVENT_MAX_COUNT: z.coerce.number().int().min(10).max(100_000).default(1_000),
    ORDER_NOTIFY_PROVIDER: z.enum(["none", "telegram"]).default("none"),
    ORDER_NOTIFY_TELEGRAM_TOKEN_FILE: z.string().default("/run/secrets/order_notify_telegram_token"),
    ORDER_NOTIFY_TELEGRAM_CHAT_ID_FILE: z.string().default("/run/secrets/order_notify_telegram_chat_id"),
  })
  .superRefine((env, context) => {
    if ((env.YANDEX_EATS_LATITUDE === undefined) !== (env.YANDEX_EATS_LONGITUDE === undefined)) {
      context.addIssue({
        code: "custom",
        message: "YANDEX_EATS_LATITUDE and YANDEX_EATS_LONGITUDE must be configured together",
      });
    }

    if (env.MCP_AUTH_MODE === "oauth" && !env.PUBLIC_BASE_URL) {
      context.addIssue({
        code: "custom",
        path: ["PUBLIC_BASE_URL"],
        message: "PUBLIC_BASE_URL is required when MCP_AUTH_MODE=oauth",
      });
    }

    if (env.MCP_AUTH_MODE === "none" && env.NODE_ENV === "production") {
      context.addIssue({
        code: "custom",
        path: ["MCP_AUTH_MODE"],
        message: "MCP_AUTH_MODE=none is forbidden in production",
      });
    }

    if (env.YANDEX_EATS_ORDER_POLL_MIN_MS > env.YANDEX_EATS_ORDER_POLL_MAX_MS) {
      context.addIssue({
        code: "custom",
        path: ["YANDEX_EATS_ORDER_POLL_MIN_MS"],
        message: "YANDEX_EATS_ORDER_POLL_MIN_MS must not exceed YANDEX_EATS_ORDER_POLL_MAX_MS",
      });
    }
  });

export type AuthMode = "oauth" | "bearer" | "none";

export type AppConfig = {
  nodeEnv: "development" | "test" | "production";
  host: string;
  port: number;
  logLevel: string;
  publicBaseUrl?: URL;
  auth: {
    mode: AuthMode;
    oauthPasswordFile: string;
    bearerTokenFile: string;
  };
  stateDir: string;
  eats: {
    baseUrl: URL;
    cookieFile: string;
    locale: string;
    platform: string;
    appVersion: string;
    latitude?: number;
    longitude?: number;
    city?: string;
    addressLabel?: string;
    shippingType: "delivery";
    timeoutMs: number;
    mutationsEnabled: boolean;
    maxSearchPlaces: number;
    maxItemsPerPlace: number;
  };
  orders: {
    enabled: boolean;
    pollMinMs: number;
    pollMaxMs: number;
    errorBackoffMaxMs: number;
    eventRetentionDays: number;
    eventMaxCount: number;
    notifier: {
      provider: "none" | "telegram";
      telegramTokenFile: string;
      telegramChatIdFile: string;
    };
  };
};

export function loadConfig(source: NodeJS.ProcessEnv = process.env): AppConfig {
  const parsed = envSchema.parse(source);
  return {
    nodeEnv: parsed.NODE_ENV,
    host: parsed.HOST,
    port: parsed.PORT,
    logLevel: parsed.LOG_LEVEL,
    ...(parsed.PUBLIC_BASE_URL ? { publicBaseUrl: normalizePublicUrl(parsed.PUBLIC_BASE_URL) } : {}),
    auth: {
      mode: parsed.MCP_AUTH_MODE,
      oauthPasswordFile: resolve(parsed.MCP_OAUTH_PASSWORD_FILE),
      bearerTokenFile: resolve(parsed.MCP_BEARER_TOKEN_FILE),
    },
    stateDir: resolve(parsed.MCP_STATE_DIR),
    eats: {
      baseUrl: new URL(parsed.YANDEX_EATS_BASE_URL),
      cookieFile: resolve(parsed.YANDEX_EATS_COOKIE_FILE),
      locale: parsed.YANDEX_EATS_LOCALE,
      platform: parsed.YANDEX_EATS_PLATFORM,
      appVersion: parsed.YANDEX_EATS_APP_VERSION,
      ...(parsed.YANDEX_EATS_LATITUDE !== undefined ? { latitude: parsed.YANDEX_EATS_LATITUDE } : {}),
      ...(parsed.YANDEX_EATS_LONGITUDE !== undefined ? { longitude: parsed.YANDEX_EATS_LONGITUDE } : {}),
      ...(parsed.YANDEX_EATS_CITY ? { city: parsed.YANDEX_EATS_CITY } : {}),
      ...(parsed.YANDEX_EATS_ADDRESS_LABEL ? { addressLabel: parsed.YANDEX_EATS_ADDRESS_LABEL } : {}),
      shippingType: parsed.YANDEX_EATS_SHIPPING_TYPE,
      timeoutMs: parsed.YANDEX_EATS_TIMEOUT_MS,
      mutationsEnabled: parsed.YANDEX_EATS_ENABLE_MUTATIONS,
      maxSearchPlaces: parsed.YANDEX_EATS_MAX_SEARCH_PLACES,
      maxItemsPerPlace: parsed.YANDEX_EATS_MAX_ITEMS_PER_PLACE,
    },
    orders: {
      enabled: parsed.YANDEX_EATS_ENABLE_ORDER_MONITORING,
      pollMinMs: parsed.YANDEX_EATS_ORDER_POLL_MIN_MS,
      pollMaxMs: parsed.YANDEX_EATS_ORDER_POLL_MAX_MS,
      errorBackoffMaxMs: parsed.YANDEX_EATS_ORDER_ERROR_BACKOFF_MAX_MS,
      eventRetentionDays: parsed.YANDEX_EATS_ORDER_EVENT_RETENTION_DAYS,
      eventMaxCount: parsed.YANDEX_EATS_ORDER_EVENT_MAX_COUNT,
      notifier: {
        provider: parsed.ORDER_NOTIFY_PROVIDER,
        telegramTokenFile: resolve(parsed.ORDER_NOTIFY_TELEGRAM_TOKEN_FILE),
        telegramChatIdFile: resolve(parsed.ORDER_NOTIFY_TELEGRAM_CHAT_ID_FILE),
      },
    },
  };
}

export function readSecretFile(path: string, label: string): string {
  let value: string;
  try {
    value = readFileSync(path, "utf8").trim();
  } catch (error) {
    const code = error instanceof Error && "code" in error ? String(error.code) : "UNKNOWN";
    throw new Error(`${label} could not be read (${code})`);
  }
  if (!value) {
    throw new Error(`${label} is empty`);
  }
  return value;
}

function normalizePublicUrl(value: string): URL {
  const url = new URL(value);
  if (url.protocol !== "https:" && url.hostname !== "localhost" && url.hostname !== "127.0.0.1") {
    throw new Error("PUBLIC_BASE_URL must use HTTPS except for localhost development");
  }
  url.pathname = url.pathname.replace(/\/$/, "");
  url.search = "";
  url.hash = "";
  return url;
}
