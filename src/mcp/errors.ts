export type EatsErrorCode =
  | "AUTH_EXPIRED"
  | "AUTH_NOT_CONFIGURED"
  | "DELIVERY_LOCATION_NOT_CONFIGURED"
  | "MUTATIONS_DISABLED"
  | "MUTATION_STATUS_UNKNOWN"
  | "PLACE_UNAVAILABLE"
  | "REQUIRES_CONFIGURATION"
  | "UNSUPPORTED_CART_MODE"
  | "UPSTREAM_BAD_RESPONSE"
  | "UPSTREAM_RATE_LIMITED"
  | "UPSTREAM_TIMEOUT"
  | "UPSTREAM_UNAVAILABLE"
  | "VALIDATION_ERROR";

export class EatsError extends Error {
  readonly code: EatsErrorCode;
  readonly retryable: boolean;
  readonly details: Record<string, unknown> | undefined;

  constructor(
    code: EatsErrorCode,
    message: string,
    options: { retryable?: boolean; details?: Record<string, unknown>; cause?: unknown } = {},
  ) {
    super(message, { cause: options.cause });
    this.name = "EatsError";
    this.code = code;
    this.retryable = options.retryable ?? false;
    this.details = options.details;
  }
}

export function toPublicError(error: unknown): {
  code: EatsErrorCode;
  message: string;
  retryable: boolean;
  details?: Record<string, unknown>;
} {
  if (error instanceof EatsError) {
    return {
      code: error.code,
      message: error.message,
      retryable: error.retryable,
      ...(error.details ? { details: error.details } : {}),
    };
  }
  return {
    code: "UPSTREAM_UNAVAILABLE",
    message: "The Yandex Eats operation failed unexpectedly.",
    retryable: false,
  };
}
