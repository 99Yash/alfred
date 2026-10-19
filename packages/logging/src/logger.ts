import { getStringField, isHttpError, isIndexable, SENSITIVE_LOG_PATHS } from "@alfred/contracts";
import { nodeEnv } from "@alfred/env/server";
import pino, { type DestinationStream } from "pino";
import { AppError } from "@alfred/contracts/app-errors";
import { pgErrorChain } from "@alfred/db/pg-errors";

type SafeErrorLog = {
  type: string;
  stack?: string | undefined;
  /** A closed catalog code, never free text. */
  appErrorCode?: string | undefined;
  /** A provider name and an HTTP status. The body and the URL can hold user data, so they stay out. */
  http?: { provider?: string | undefined; status?: number | undefined };
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

  const message = err instanceof Error ? getStringField(err, "message") : undefined;

  if (message) out.message = message;
  const statusCode: unknown = Reflect.get(isIndexable(err) ? err : {}, "statusCode");

  // oxlint-disable-next-line anti-slop/no-runtime-typeof -- `statusCode` is read off an unknown thrown value for dev logs; a non-number is dropped, not parsed.
  if (typeof statusCode === "number") out.statusCode = statusCode;
  const url = getStringField(err, "url");

  if (url) out.url = url;
  const responseBody = getStringField(err, "responseBody");

  if (responseBody) out.responseBody = responseBody.slice(0, RESPONSE_BODY_LOG_CAP);

  return out;
}

/**
 * Codes only: an `AppError` code and an `HttpError` provider and status. No field here carries free text.
 * Never throws: a getter that throws drops the codes, not the type and stack beside them.
 */
function safeErrorCodes(err: unknown): Pick<SafeErrorLog, "appErrorCode" | "http"> {
  try {
    if (err instanceof AppError) {
      const appErrorCode = getStringField(err, "code");

      return appErrorCode ? { appErrorCode } : {};
    }

    if (!isHttpError(err)) return {};
    const status: unknown = Reflect.get(err, "status");

    return {
      http: {
        provider: getStringField(err, "provider"),
        // oxlint-disable-next-line anti-slop/no-runtime-typeof -- `status` is read once off a thrown value; a non-number is dropped, not parsed.
        ...(typeof status === "number" ? { status } : {}),
      },
    };
  } catch {
    return {};
  }
}

function isPostgresDiagnostic(value: unknown): boolean {
  const code = getStringField(value, "code");

  return code !== undefined && /^[0-9A-Z]{5}$/.test(code);
}

/**
 * Allowlist an error for logs. In production, never `message`, `detail`, `query`, or `parameters`:
 * Postgres can put user data and SQL there. Keep only stack frames, since line one repeats `message`.
 * Never throws: pino rethrows a serializer throw out of the log call, so a value whose
 * prototype or getters throw collapses to `{ type: typeof err }`.
 */
export function serializeError(err: unknown, verbose = false): SafeErrorLog {
  try {
    const error: unknown = err instanceof Error ? err : undefined;
    let databaseSource: unknown;

    for (const level of pgErrorChain(err)) {
      if (isPostgresDiagnostic(level)) databaseSource = level;
    }

    const database = {
      code: getStringField(databaseSource, "code"),
      constraint: getStringField(databaseSource, "constraint"),
      schema: getStringField(databaseSource, "schema"),
      table: getStringField(databaseSource, "table"),
      column: getStringField(databaseSource, "column"),
    };

    const hasDatabaseField = Object.values(database).some((value) => value !== undefined);

    const stack = getStringField(error, "stack")
      ?.split("\n")
      .filter((line) => /^\s*at\s/.test(line))
      .join("\n")
      .trim();

    return {
      // oxlint-disable-next-line anti-slop/no-runtime-typeof -- the runtime type name IS the logged value when a thrown value has no `name`.
      type: getStringField(error, "name") ?? typeof err,
      ...(stack ? { stack } : {}),
      ...safeErrorCodes(err),
      ...(hasDatabaseField ? { database } : {}),
      ...(verbose ? devErrorDiagnostics(err) : {}),
    };
  } catch {
    // oxlint-disable-next-line anti-slop/no-runtime-typeof -- the runtime type name IS the logged value when the diagnostics read throws.
    return { type: typeof err };
  }
}

/** A bounded, allowlisted diagnostic suitable for traces and other text-only sinks. Never throws. */
export function safeErrorDiagnostic(err: unknown): string {
  const serialized = serializeError(err);
  const { database, http } = serialized;

  try {
    return [
      serialized.appErrorCode ?? serialized.type,
      http
        ? `provider=${http.provider ?? "unknown"} status=${http.status ?? "unknown"}`
        : undefined,
      database?.code ? `sqlstate=${database.code}` : undefined,
      database?.constraint ? `constraint=${database.constraint}` : undefined,
    ]
      .filter((part): part is string => part !== undefined)
      .join(" ");
  } catch {
    return serialized.type;
  }
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
