import { isIndexable, isNonEmptyString, isRecord } from "./guards";

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

/** Extra machine-readable context on a failure. Rendered into the wire body. */
export type ApiErrorDetails = Record<string, unknown>;

export interface ApiErrorResponse {
  error: string;
  code: ApiErrorCode;
  details?: ApiErrorDetails;
}

/**
 * The one code-to-status table. Each {@link ApiErrorCode} maps to exactly one
 * HTTP status, so a thrown error never carries a status that disagrees with its
 * code, and the error handler never hard-codes a number.
 */
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

/**
 * A failure the HTTP surface knows how to answer with. One class for every
 * code: the code is the discriminant, `statusCode` is derived from it, and the
 * message is what the client reads.
 *
 * Build one through {@link Errors} rather than calling the constructor, and
 * branch on the code with {@link isApiError} rather than on a class identity.
 */
export class ApiError extends Error {
  readonly _tag = "ApiError" as const;
  readonly code: ApiErrorCode;
  readonly statusCode: number;
  readonly details: ApiErrorDetails | undefined;

  constructor(code: ApiErrorCode, message: string, details?: ApiErrorDetails) {
    super(message);
    this.name = "ApiError";
    this.code = code;
    this.statusCode = API_ERROR_STATUS[code];
    this.details = details;
  }
}

/**
 * Every failure the HTTP surface can raise, under one name you can autocomplete
 * through. Type `Errors.` and the editor lists the whole set with its status and
 * meaning — there is nothing to remember and nothing to import per kind.
 *
 * These are factories, not classes, so no `new`:
 *
 *   throw Errors.NotFoundError("Thread not found");
 *   throw Errors.TooManyRequestsError("Slow down.", { retryAfterSeconds: 60 });
 *
 * To catch one, ask about the code — `isApiError(err, "NOT_FOUND")`. There is no
 * per-kind class to test, on purpose: the code already travels on the wire, so a
 * class hierarchy beside it would be a second encoding of the same enum.
 */
export const Errors = {
  /** 400 — the request is malformed, or fails a precondition the client can fix. */
  BadRequestError: (message = "Bad request", details?: ApiErrorDetails) =>
    new ApiError("BAD_REQUEST", message, details),

  /** 401 — no usable credential on the request. */
  UnauthorizedError: (message = "Unauthorized", details?: ApiErrorDetails) =>
    new ApiError("UNAUTHORIZED", message, details),

  /** 403 — authenticated, but not allowed to touch this resource. */
  ForbiddenError: (message = "Forbidden", details?: ApiErrorDetails) =>
    new ApiError("FORBIDDEN", message, details),

  /** 404 — the addressed resource does not exist for this caller. */
  NotFoundError: (message = "Not found", details?: ApiErrorDetails) =>
    new ApiError("NOT_FOUND", message, details),

  /** 409 — the write conflicts with the current state (duplicate, lost race). */
  ConflictError: (message = "Conflict", details?: ApiErrorDetails) =>
    new ApiError("CONFLICT", message, details),

  /** 413 — the body exceeds a declared size bound. */
  PayloadTooLargeError: (message = "Payload too large", details?: ApiErrorDetails) =>
    new ApiError("PAYLOAD_TOO_LARGE", message, details),

  /** 429 — a rate limit or a quota rejected the call. */
  TooManyRequestsError: (message = "Too many requests", details?: ApiErrorDetails) =>
    new ApiError("TOO_MANY_REQUESTS", message, details),

  /** 503 — a dependency this route needs is down or unreachable. */
  ServiceUnavailableError: (message = "Service unavailable", details?: ApiErrorDetails) =>
    new ApiError("SERVICE_UNAVAILABLE", message, details),

  /** 502 — an upstream provider answered, but with a failure we cannot use. */
  BadGatewayError: (message = "Bad gateway", details?: ApiErrorDetails) =>
    new ApiError("BAD_GATEWAY", message, details),

  /** 400 — the payload failed schema validation. */
  ValidationError: (message = "Validation failed", details?: ApiErrorDetails) =>
    new ApiError("VALIDATION_ERROR", message, details),

  /** 400 — the body could not be parsed at all. */
  ParseError: (message = "Invalid request body", details?: ApiErrorDetails) =>
    new ApiError("PARSE_ERROR", message, details),

  /** 500 — a bug or an invariant break on our side. */
  InternalServerError: (message = "Internal server error", details?: ApiErrorDetails) =>
    new ApiError("INTERNAL_SERVER_ERROR", message, details),
} as const;

/**
 * Test a caught value for an {@link ApiError}, optionally narrowing to a set of
 * codes. With no codes it answers "is this one of ours at all"; with codes it
 * replaces a chain of per-class `instanceof` tests:
 *
 *   if (isApiError(err, "BAD_REQUEST", "CONFLICT")) throw err;
 */
export function isApiError(err: unknown, ...codes: readonly ApiErrorCode[]): err is ApiError {
  if (!(err instanceof ApiError)) return false;
  return codes.length === 0 || codes.includes(err.code);
}

/** Render an {@link ApiError} as the canonical wire body. */
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

function isApiErrorCode(value: unknown): value is ApiErrorCode {
  return typeof value === "string" && API_ERROR_CODES.includes(value as ApiErrorCode);
}
