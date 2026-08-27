import pino, { type Logger } from "pino";

const REDACT_PATHS = [
  "req.headers.authorization",
  "req.headers.cookie",
  "req.headers.x-eats-session",
  "headers.authorization",
  "headers.cookie",
  "headers.x-eats-session",
  "authorization",
  "cookie",
  "cookies",
  "token",
  "access_token",
  "refresh_token",
  "password",
  "phone",
  "address",
  "payment",
  "payment_information",
  "*.authorization",
  "*.cookie",
  "*.cookies",
  "*.token",
  "*.password",
  "*.phone",
  "*.address",
  "*.payment",
];

export function createLogger(level = "info"): Logger {
  return pino({
    level,
    base: null,
    redact: {
      paths: REDACT_PATHS,
      censor: "[REDACTED]",
    },
  });
}
