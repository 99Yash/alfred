import { isHttpError, isIndexable, SENSITIVE_LOG_PATHS } from "@alfred/contracts";
import { nodeEnv } from "@alfred/env/server";
import pino, { type DestinationStream } from "pino";
import { AppError } from "@alfred/contracts/app-errors";
import { pgErrorChain } from "@alfred/db/pg-errors";

type SafeErrorLog = {
  type: string;
  stack?: string | undefined;
  database?: {
    code?: string | undefined;
    constraint?: string | undefined;
    schema?: string | undefined;
    table?: string | undefined;
    column?: string | undefined;
  };
  // Verbose mode only. See {@link devErrorDiagnostics}.
  message?: string | undefined;
  statusCode?: number | undefined;
  responseBody?: string | undefined;
  url?: string | undefined;
};

const RESPONSE_BODY_LOG_CAP = 4_000;

/** Raw fields that production logs strip: `message`, and an `APICallError`'s status, body, and url. */
function devErrorDiagnostics(err: unknown): Partial<SafeErrorLog> {
  const out: Partial<SafeErrorLog> = {};

  if (err instanceof Error && err.message) out.message = err.message;
  const statusCode = Reflect.get(isIndexable(err) ? err : {}, "statusCode");

  if (typeof statusCode === "number") out.statusCode = statusCode;
  const url = stringField(err, "url");

  if (url) out.url = url;
  const responseBody = stringField(err, "responseBody");

  if (responseBody) out.responseBody = responseBody.slice(0, RESPONSE_BODY_LOG_CAP);

  return out;
}

function stringField(value: unknown, key: string): string | undefined {
  if (!isIndexable(value)) return undefined;
  const field = Reflect.get(value, key);

  return typeof field === "string" ? field : undefined;
}

function isPostgresDiagnostic(value: unknown): boolean {
  const code = stringField(value, "code");

  return code !== undefined && /^[0-9A-Z]{5}$/.test(code);
}

/**
 * Allowlist an error for logs. Never `message`, `detail`, `query`, or `parameters`:
 * Postgres can put user data and SQL there. Keep only stack frames, since line one repeats `message`.
 */
export function serializeError(err: unknown, verbose = false): SafeErrorLog {
  const error = err instanceof Error ? err : undefined;
  let databaseSource: unknown;

  for (const level of pgErrorChain(err)) {
    if (isPostgresDiagnostic(level)) databaseSource = level;
  }

  const database = {
    code: stringField(databaseSource, "code"),
    constraint: stringField(databaseSource, "constraint"),
    schema: stringField(databaseSource, "schema"),
    table: stringField(databaseSource, "table"),
    column: stringField(databaseSource, "column"),
  };

  const hasDatabaseField = Object.values(database).some((value) => value !== undefined);

  const stack = error?.stack
    ?.split("\n")
    .filter((line) => /^\s*at\s/.test(line))
    .join("\n")
    .trim();

  return {
    type: error?.name ?? typeof err,
    ...(stack ? { stack } : {}),
    ...(hasDatabaseField ? { database } : {}),
    ...(verbose ? devErrorDiagnostics(err) : {}),
  };
}

/** A bounded, allowlisted diagnostic suitable for traces and other text-only sinks. */
export function safeErrorDiagnostic(err: unknown): string {
  const serialized = serializeError(err);
  const database = serialized.database;

  return [
    err instanceof AppError ? err.code : serialized.type,
    // Provider and status only. The body and URL can hold user data, so they stay out.
    isHttpError(err) ? `provider=${err.provider} status=${err.status}` : undefined,
    database?.code ? `sqlstate=${database.code}` : undefined,
    database?.constraint ? `constraint=${database.constraint}` : undefined,
  ]
    .filter((part): part is string => part !== undefined)
    .join(" ");
}

export function createLogger(destination?: DestinationStream, opts?: { verboseErrors?: boolean }) {
  // Runs at import, before the env is validated, so use `nodeEnv()`, which never throws.
  const verbose = opts?.verboseErrors ?? nodeEnv() !== "production";

  const options = {
    name: "alfred-api",
    serializers: { err: (err: unknown) => serializeError(err, verbose) },
    redact: { paths: [...SENSITIVE_LOG_PATHS], censor: "[redacted]" },
  };

  return destination ? pino(options, destination) : pino(options);
}

export const logger = createLogger();
