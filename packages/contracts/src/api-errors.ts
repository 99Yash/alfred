import { enumGuard, isIndexable, isNonEmptyString, isRecord } from "./guards";
import type { JsonObject } from "./user-model";

export const API_ERROR_CODES = [
  "BAD_REQUEST",
  "UNAUTHORIZED",
  "FORBIDDEN",
  "NOT_FOUND",
  "CONFLICT",
  "PAYLOAD_TOO_LARGE",
  "TOO_MANY_REQUESTS",
  "SERVICE_UNAVAILABLE",
  "BAD_GATEWAY",
  "VALIDATION_ERROR",
  "PARSE_ERROR",
  "INTERNAL_SERVER_ERROR",
] as const;

export type ApiErrorCode = (typeof API_ERROR_CODES)[number];

export interface ApiErrorResponse {
  error: string;
  code: ApiErrorCode;
  /** Machine-readable context, sent on the wire. */
  details?: JsonObject;
}

/** Each code maps to one HTTP status, so a status cannot disagree with its code. */
export const API_ERROR_STATUS = {
  BAD_REQUEST: 400,
  UNAUTHORIZED: 401,
  FORBIDDEN: 403,
  NOT_FOUND: 404,
  CONFLICT: 409,
  PAYLOAD_TOO_LARGE: 413,
  TOO_MANY_REQUESTS: 429,
  SERVICE_UNAVAILABLE: 503,
  BAD_GATEWAY: 502,
  VALIDATION_ERROR: 400,
  PARSE_ERROR: 400,
  INTERNAL_SERVER_ERROR: 500,
} satisfies Record<ApiErrorCode, number>;

/** An HTTP failure for the client. Build it with `Errors` and test it with `isApiError`. */
export class ApiError extends Error {
  readonly _tag = "ApiError" as const;
  readonly code: ApiErrorCode;
  readonly statusCode: number;
  readonly details: JsonObject | undefined;

  constructor(code: ApiErrorCode, message: string, details?: JsonObject) {
    super(message);
    this.name = "ApiError";
    this.code = code;
    this.statusCode = API_ERROR_STATUS[code];
    this.details = details;
  }
}

/**
 * Factories, not classes: `throw Errors.NotFoundError("Thread not found")`.
 * Catch by code with `isApiError(err, "NOT_FOUND")`.
 */
export const Errors = {
  /** 400: malformed, or a precondition the client can fix. */
  BadRequestError: (message = "Bad request", details?: JsonObject) =>
    new ApiError("BAD_REQUEST", message, details),

  /** 401: no usable credential. */
  UnauthorizedError: (message = "Unauthorized", details?: JsonObject) =>
    new ApiError("UNAUTHORIZED", message, details),

  /** 403: signed in, but not allowed. */
  ForbiddenError: (message = "Forbidden", details?: JsonObject) =>
    new ApiError("FORBIDDEN", message, details),

  /** 404 */
  NotFoundError: (message = "Not found", details?: JsonObject) =>
    new ApiError("NOT_FOUND", message, details),

  /** 409: duplicate or lost race. */
  ConflictError: (message = "Conflict", details?: JsonObject) =>
    new ApiError("CONFLICT", message, details),

  /** 413 */
  PayloadTooLargeError: (message = "Payload too large", details?: JsonObject) =>
    new ApiError("PAYLOAD_TOO_LARGE", message, details),

  /** 429: rate limit or quota. */
  TooManyRequestsError: (message = "Too many requests", details?: JsonObject) =>
    new ApiError("TOO_MANY_REQUESTS", message, details),

  /** 503: a dependency is down. */
  ServiceUnavailableError: (message = "Service unavailable", details?: JsonObject) =>
    new ApiError("SERVICE_UNAVAILABLE", message, details),

  /** 502: the upstream answered with a failure. */
  BadGatewayError: (message = "Bad gateway", details?: JsonObject) =>
    new ApiError("BAD_GATEWAY", message, details),

  /** 400: failed schema validation. */
  ValidationError: (message = "Validation failed", details?: JsonObject) =>
    new ApiError("VALIDATION_ERROR", message, details),

  /** 400: the body did not parse. */
  ParseError: (message = "Invalid request body", details?: JsonObject) =>
    new ApiError("PARSE_ERROR", message, details),

  /** 500: our bug. */
  InternalServerError: (message = "Internal server error", details?: JsonObject) =>
    new ApiError("INTERNAL_SERVER_ERROR", message, details),
} as const;

/** With no codes, matches any `ApiError`. */
export function isApiError(err: unknown, ...codes: readonly ApiErrorCode[]): err is ApiError {
  if (!(err instanceof ApiError)) return false;

  return codes.length === 0 || codes.includes(err.code);
}

export function apiErrorResponse(error: ApiError): ApiErrorResponse {
  return {
    error: error.message,
    code: error.code,
    ...(error.details ? { details: error.details } : {}),
  };
}

export function isApiErrorResponse(value: unknown): value is ApiErrorResponse {
  if (!isRecord(value)) return false;
  const record = value;

  return (
    typeof record.error === "string" &&
    isApiErrorCode(record.code) &&
    (record.details === undefined || isRecord(record.details))
  );
}

export function apiErrorMessage(value: unknown, fallback: string): string {
  if (isApiErrorResponse(value)) return value.error;

  if (value instanceof Error && value.message.length > 0) return value.message;

  if (isIndexable(value)) {
    const message = Reflect.get(value, "message");

    if (isNonEmptyString(message)) return message;
  }

  return fallback;
}

const isApiErrorCode = enumGuard(API_ERROR_CODES);
