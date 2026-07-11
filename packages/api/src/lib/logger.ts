import pino, { type DestinationStream } from "pino";

const REDACT_PATHS = [
  "req.headers.authorization",
  "req.headers.cookie",
  "*.accessToken",
  "*.refreshToken",
  "*.apiKey",
  "*.clientSecret",
  "*.password",
] as const;

type SafeErrorLog = {
  type: string;
  stack?: string;
  database?: {
    code?: string;
    constraint?: string;
    schema?: string;
    table?: string;
    column?: string;
  };
};

function stringField(value: unknown, key: string): string | undefined {
  if ((typeof value !== "object" && typeof value !== "function") || value === null)
    return undefined;
  const field = Reflect.get(value, key);
  return typeof field === "string" ? field : undefined;
}

function causeOf(value: unknown): unknown {
  if ((typeof value !== "object" && typeof value !== "function") || value === null)
    return undefined;
  return Reflect.get(value, "cause");
}

function isPostgresDiagnostic(value: unknown): boolean {
  const code = stringField(value, "code");
  return code !== undefined && /^[0-9A-Z]{5}$/.test(code);
}

/**
 * Allowlist an exception for logs. In particular, never serialize `message`,
 * `detail`, `query`, or `parameters`: Drizzle/Postgres may place user data and
 * raw SQL there. The first stack line repeats `message`, so retain frames only.
 */
export function serializeError(err: unknown): SafeErrorLog {
  const error = err instanceof Error ? err : undefined;
  let cause: unknown = err;
  let databaseSource: unknown;
  for (let depth = 0; depth < 4 && cause !== undefined; depth += 1) {
    if (isPostgresDiagnostic(cause)) databaseSource = cause;
    cause = causeOf(cause);
  }
  const database = {
    code: stringField(databaseSource, "code"),
    constraint: stringField(databaseSource, "constraint"),
    schema: stringField(databaseSource, "schema"),
    table: stringField(databaseSource, "table"),
    column: stringField(databaseSource, "column"),
  };
  const hasDatabaseField = Object.values(database).some((value) => value !== undefined);
  const stack = error?.stack?.split("\n").slice(1).join("\n").trim();
  return {
    type: error?.name ?? typeof err,
    ...(stack ? { stack } : {}),
    ...(hasDatabaseField ? { database } : {}),
  };
}

/** A bounded, allowlisted diagnostic suitable for traces and other text-only sinks. */
export function safeErrorDiagnostic(err: unknown): string {
  const serialized = serializeError(err);
  const database = serialized.database;
  return [
    serialized.type,
    database?.code ? `sqlstate=${database.code}` : undefined,
    database?.constraint ? `constraint=${database.constraint}` : undefined,
  ]
    .filter((part): part is string => part !== undefined)
    .join(" ");
}

export function createLogger(destination?: DestinationStream) {
  const options = {
    name: "alfred-api",
    serializers: { err: serializeError },
    redact: { paths: [...REDACT_PATHS], censor: "[redacted]" },
  };
  return destination ? pino(options, destination) : pino(options);
}

export const logger = createLogger();
