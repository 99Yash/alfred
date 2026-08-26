import { isRecord } from "./guards";

/**
 * The one redaction table every log sink pulls from — ADR-0038's promised
 * `SENSITIVE_LOG_PATHS` in `@alfred/contracts`, so Pino, Sentry, and any
 * future logger cannot drift apart on what counts as a secret field.
 *
 * Path syntax is the subset both sinks need:
 *   - an exact dotted path (`req.headers.authorization`) matches that one
 *     nested location;
 *   - a leading `*.` segment (`*.accessToken`) matches the remainder of the
 *     path under any top-level key.
 *
 * {@link redactSensitiveLogPaths} interprets the same table for sinks that
 * take no pino-style path config (Sentry's `beforeSend` / `beforeBreadcrumb`),
 * so adding a path here covers every sink at once.
 */
export const SENSITIVE_LOG_PATHS = [
  "req.headers.authorization",
  "req.headers.cookie",
  "*.accessToken",
  "*.refreshToken",
  "*.apiKey",
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

/**
 * Return a copy of `value` with every leaf reached by a {@link SENSITIVE_LOG_PATHS}
 * pattern replaced with `[redacted]`. Pure and total: it never throws and never
 * mutates its input, so a sink hook can apply it to any event payload.
 */
export function redactSensitiveLogPaths<T>(value: T): T {
  // SAFETY: walk copies arrays and plain records structurally and passes every
  // other value through by reference; the only content change is a matched
  // path's value becoming the CENSOR string, so the tree keeps T's shape.
  return walk(value, []) as T;
}
