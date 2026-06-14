import type { ApiErrorCode, ApiErrorResponse } from "@alfred/contracts";

export type { ApiErrorCode, ApiErrorResponse } from "@alfred/contracts";

export class ApiError extends Error {
  constructor(
    public readonly statusCode: number,
    public readonly code: ApiErrorCode,
    message: string,
    public readonly details?: Record<string, unknown>,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

export function apiErrorResponse(error: ApiError): ApiErrorResponse {
  return {
    error: error.message,
    code: error.code,
    ...(error.details ? { details: error.details } : {}),
  };
}

export class BadRequestError extends ApiError {
  constructor(message = "Bad request", details?: Record<string, unknown>) {
    super(400, "BAD_REQUEST", message, details);
    this.name = "BadRequestError";
  }
}

export class NotFoundError extends ApiError {
  constructor(message = "Not found", details?: Record<string, unknown>) {
    super(404, "NOT_FOUND", message, details);
    this.name = "NotFoundError";
  }
}

export class ForbiddenError extends ApiError {
  constructor(message = "Forbidden", details?: Record<string, unknown>) {
    super(403, "FORBIDDEN", message, details);
    this.name = "ForbiddenError";
  }
}

export class UnauthorizedError extends ApiError {
  constructor(message = "Unauthorized", details?: Record<string, unknown>) {
    super(401, "UNAUTHORIZED", message, details);
    this.name = "UnauthorizedError";
  }
}

export class ConflictError extends ApiError {
  constructor(message = "Conflict", details?: Record<string, unknown>) {
    super(409, "CONFLICT", message, details);
    this.name = "ConflictError";
  }
}

export class PayloadTooLargeError extends ApiError {
  constructor(message = "Payload too large", details?: Record<string, unknown>) {
    super(413, "PAYLOAD_TOO_LARGE", message, details);
    this.name = "PayloadTooLargeError";
  }
}

export class TooManyRequestsError extends ApiError {
  constructor(message = "Too many requests", details?: Record<string, unknown>) {
    super(429, "TOO_MANY_REQUESTS", message, details);
    this.name = "TooManyRequestsError";
  }
}

export class ServiceUnavailableError extends ApiError {
  constructor(message = "Service unavailable", details?: Record<string, unknown>) {
    super(503, "SERVICE_UNAVAILABLE", message, details);
    this.name = "ServiceUnavailableError";
  }
}

export class BadGatewayError extends ApiError {
  constructor(message = "Bad gateway", details?: Record<string, unknown>) {
    super(502, "BAD_GATEWAY", message, details);
    this.name = "BadGatewayError";
  }
}

export class InternalServerError extends ApiError {
  constructor(message = "Internal server error", details?: Record<string, unknown>) {
    super(500, "INTERNAL_SERVER_ERROR", message, details);
    this.name = "InternalServerError";
  }
}
