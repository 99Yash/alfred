import { isIndexable } from "@alfred/contracts";
import { serverEnv } from "@alfred/env/server";
import pino, { type DestinationStream } from "pino";
import { AppError } from "./app-errors";
import { pgErrorChain } from "./pg-errors";

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
  // Verbose (non-production) diagnostics only — the production allowlist above
  // never sets these. See {@link devErrorDiagnostics}.
  message?: string;
  statusCode?: number;
  responseBody?: string;
  url?: string;
};

const RESPONSE_BODY_LOG_CAP = 4_000;

/**
 * The raw fields the production allowlist deliberately strips: the error
 * `message` and — for AI SDK / HTTP `APICallError`s — the provider's
 * `statusCode`, `responseBody`, and `url`. Only spread in when the logger is
 * built in verbose mode ({@link createLogger}), turning an opaque
 * `{type:"AI_APICallError"}` into the actual cause (e.g. Anthropic's
 * `tools.N.custom.input_schema.type: Field required`). `responseBody` is capped
 * so a large provider body can't flood the logs.
 */
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
 * Allowlist an exception for logs. In particular, never serialize `message`,
 * `detail`, `query`, or `parameters`: Drizzle/Postgres may place user data and
 * raw SQL there. The first stack line repeats `message`, so retain frames only.
 *
 * `verbose` (non-production only; wired by {@link createLogger}) additionally
 * spreads in the raw {@link devErrorDiagnostics}. It defaults to `false`, so
 * every other caller — and the trace-facing {@link safeErrorDiagnostic} — keeps
 * the strict production shape.
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
    database?.code ? `sqlstate=${database.code}` : undefined,
    database?.constraint ? `constraint=${database.constraint}` : undefined,
  ]
    .filter((part): part is string => part !== undefined)
    .join(" ");
}

/**
 * Whether the running process is non-production. Outside production the
 * operator owns the logs, so verbose error diagnostics are safe to surface.
 * `serverEnv()` throwing (unvalidated env in bare test runs) falls back to
 * `false`, keeping logging strict by default.
 */
function isNonProduction(): boolean {
  try {
    return serverEnv().NODE_ENV !== "production";
  } catch {
    return false;
  }
}

export function createLogger(destination?: DestinationStream, opts?: { verboseErrors?: boolean }) {
  // Decided once at construction. The dev server loads `--env-file=.env` before
  // any import, so `serverEnv()` resolves here; production pins
  // `NODE_ENV=production` → strict. Tests pass `verboseErrors` explicitly.
  const verbose = opts?.verboseErrors ?? isNonProduction();
  const options = {
    name: "alfred-api",
    serializers: { err: (err: unknown) => serializeError(err, verbose) },
    redact: { paths: [...REDACT_PATHS], censor: "[redacted]" },
  };
  return destination ? pino(options, destination) : pino(options);
}

export const logger = createLogger();
