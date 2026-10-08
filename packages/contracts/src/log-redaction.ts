import { isRecord } from "./guards";

/**
 * The one redaction table for every log sink (ADR-0038). Pino reads it as path config;
 * Sentry uses `redactSensitiveLogPaths`. A leading `*` matches any top-level key.
 */
export const SENSITIVE_LOG_PATHS = [
  "req.headers.authorization",
  "req.headers.cookie",
  "*.accessToken",
  "*.refreshToken",
  "*.apiKey",
  "*.auth.value",
  "*.clientSecret",
  "*.password",
] as const;

const CENSOR = "[redacted]";

const PATTERNS: readonly string[][] = SENSITIVE_LOG_PATHS.map((path) => path.split("."));

function matches(pattern: readonly string[], path: readonly string[]): boolean {
  return (
    pattern.length === path.length &&
    pattern.every((segment, index) => segment === "*" || segment === path[index])
  );
}

function walk(value: unknown, path: readonly string[]): unknown {
  if (Array.isArray(value)) return value.map((item) => walk(item, path));

  if (!isRecord(value)) return value;

  return Object.entries(value).reduce<Record<string, unknown>>((out, [key, child]) => {
    const next = [...path, key];
    out[key] = PATTERNS.some((pattern) => matches(pattern, next)) ? CENSOR : walk(child, next);

    return out;
  }, {});
}

/** A copy of `value` with each matched path set to `[redacted]`. Never throws or mutates. */
export function redactSensitiveLogPaths<T>(value: T): T {
  // SAFETY: `walk` keeps the shape; it only swaps matched values for a string.
  return walk(value, []) as T;
}
