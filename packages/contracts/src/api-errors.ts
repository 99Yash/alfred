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

export interface ApiErrorResponse {
  error: string;
  code: ApiErrorCode;
  details?: Record<string, unknown>;
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
