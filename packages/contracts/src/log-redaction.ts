import { isRecord } from "./guards";

/**
 * The one redaction table for every log sink (ADR-0038). Pino runs it in a `formatters.log`
 * hook and Sentry in `beforeSend`, both through `redactSensitiveLogPaths`.
 *
 * Each entry matches at any depth. A one-key entry (`accessToken`) censors that key in any
 * object. A dotted entry (`headers.authorization`) censors the last key only under the keys
 * before it, so it covers `req.headers` (Pino) and `request.headers` (Sentry). Keys compare
 * without case, `_`, or `-`, so `access_token` and `Access-Token` match `accessToken`.
 */
export const SENSITIVE_LOG_PATHS = [
  "accessToken",
  "refreshToken",
  "idToken",
  "codeVerifier",
  "token",
  "apiKey",
  "clientSecret",
  "secret",
  "privateKey",
  "password",
  "auth.value",
  "headers.authorization",
  "headers.cookie",
  "headers.set-cookie",
] as const;

const CENSOR = "[redacted]";

/** Pino writes the same marker for a cycle. */
const CIRCULAR = "[Circular]";

/** `access_token`, `accessToken`, and `Access-Token` compare equal. */
function normalizeKey(key: string): string {
  return key.replaceAll("_", "").replaceAll("-", "").toLowerCase();
}

/**
 * Last key → the parent keys that each entry needs, outermost first. An empty list matches
 * under any parent. One map lookup per key keeps the walk cheap on every log line.
 */
const RULES: ReadonlyMap<string, readonly (readonly string[])[]> = SENSITIVE_LOG_PATHS.reduce(
  (rules, path) => {
    const segments = path.split(".").map(normalizeKey);
    const last = segments.at(-1);

    if (last === undefined) return rules;
    rules.set(last, [...(rules.get(last) ?? []), segments.slice(0, -1)]);

    return rules;
  },
  new Map<string, (readonly string[])[]>(),
);

function isSensitive(key: string, parents: readonly string[]): boolean {
  const required = RULES.get(key);

  if (required === undefined) return false;

  return required.some((suffix) => {
    const offset = parents.length - suffix.length;

    return offset >= 0 && suffix.every((segment, index) => parents[offset + index] === segment);
  });
}

/** One key of a plain object: a secret, a cycle back to an ancestor, or a value to walk. */
function redactEntry(
  key: string,
  child: unknown,
  parents: string[],
  ancestors: Set<unknown>,
): readonly [string, unknown] {
  const normalized = normalizeKey(key);

  if (isSensitive(normalized, parents)) return [key, CENSOR];

  if (ancestors.has(child)) return [key, CIRCULAR];
  parents.push(normalized);
  const redacted = walk(child, parents, ancestors);
  parents.pop();

  return [key, redacted];
}

/**
 * `parents` holds the normalized keys from the root to `value`, and `ancestors` the objects on
 * that path. Both change in place, so a key costs no path copy.
 */
// oxlint-disable-next-line anti-slop/no-unknown-returns -- the redaction walk returns its unknown input with secret keys masked; the shape is the input's.
function walk(value: unknown, parents: string[], ancestors: Set<unknown>): unknown {
  if (!Array.isArray(value) && !isRecord(value)) return value;
  ancestors.add(value);

  const redacted = Array.isArray(value)
    ? value.map((item) => (ancestors.has(item) ? CIRCULAR : walk(item, parents, ancestors)))
    : Object.fromEntries(
        Object.entries(value).map(([key, child]) => redactEntry(key, child, parents, ancestors)),
      );

  ancestors.delete(value);

  return redacted;
}

/**
 * A copy of `value` with each matched key set to `[redacted]`, and each cycle set to
 * `[Circular]`. Never mutates. Class instances (an `Error`, a `Date`) pass through as they are.
 */
export function redactSensitiveLogPaths<T>(value: T): T {
  // SAFETY: `walk` keeps the shape; it only swaps matched values for a string.
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- a generic walker that keeps the shape
  return walk(value, [], new Set()) as T;
}
