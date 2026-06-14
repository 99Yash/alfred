/**
 * Runtime type guards for narrowing `unknown` / `object` values safely.
 *
 * The motivating case: code that digs into loosely-typed payloads — provider
 * metadata, parsed JSON blobs, webhook bodies — kept reaching for
 *
 *   if (x && typeof x === "object") (x as Record<string, unknown>).foo
 *
 * `typeof x === "object"` is `true` for arrays AND for `null`, so that cast
 * asserts a shape nothing actually checked: `.foo` on an array reads a
 * surprising index, and the chain blows up the moment a level is missing. The
 * guards below do the real check once, in one place, and the `getPath` walker
 * collapses the nested-cast ladder into a single call that never throws.
 */

/**
 * True only for plain object values — not `null`, not an array. This is the
 * narrowing `typeof x === "object"` should have been: after it, indexing a
 * key yields `unknown` (which you then narrow), and arrays/null are excluded.
 */
export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** True for a usable string — the common "present and non-empty" check. */
export function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

/**
 * Coerce an `unknown` (typically a nullable `jsonb` column) to a record,
 * falling back to an empty object when it isn't one. Replaces the repeated
 * `(x as Record<string, unknown> | null) ?? {}` — which lied for arrays and
 * primitives — with a check that actually holds: the result is always a real
 * record, so reading keys off it is sound.
 */
export function toRecord(value: unknown): Record<string, unknown> {
  return isRecord(value) ? value : {};
}

/**
 * Coerce an `unknown` to a `string[]`, dropping any non-string elements and
 * yielding `[]` when the value isn't an array. Replaces
 * `Array.isArray(x) ? (x as string[]) : []` — which asserted the element type
 * without checking it — with a coercion that actually holds at runtime.
 */
export function toStringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((v): v is string => typeof v === "string") : [];
}

/**
 * Walk a chain of object keys through an `unknown` value, returning whatever
 * sits at the end — or `undefined` if any link along the way isn't a record
 * or the key is absent. Never throws.
 *
 * The result is deliberately `unknown`: narrow it at the leaf with the guard
 * that matches what you expect (`isRecord`, `Array.isArray`, `isNonEmptyString`,
 * …). This replaces the repeated "check object → cast to Record → index →
 * check object → cast → index" ladder with one expression:
 *
 *   const chunks = getPath(meta, "google", "groundingMetadata", "groundingChunks");
 *   if (Array.isArray(chunks)) { ... }
 */
export function getPath(value: unknown, ...keys: string[]): unknown {
  let current: unknown = value;
  for (const key of keys) {
    if (!isRecord(current)) return undefined;
    current = current[key];
  }
  return current;
}
