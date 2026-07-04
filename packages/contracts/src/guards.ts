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
 * True only for plain object records — not `null`, arrays, Date, Map, or class
 * instances. This is the narrowing most `typeof x === "object"` checks meant:
 * after it, indexing a key yields `unknown` (which you then narrow), and exotic
 * objects are excluded instead of being silently treated as JSON.
 */
export function isRecord(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

/** Alias for call sites where the plain-object requirement is the point being documented. */
export function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return isRecord(value);
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

/**
 * Typed leaf reader for the common "walk JSON, then accept only a string"
 * pattern. Keep `getPath` for non-string leaves; use this when the caller would
 * otherwise immediately write `typeof leaf === "string" ? leaf : undefined`.
 */
export function getStringPath(value: unknown, ...keys: string[]): string | undefined {
  const leaf = getPath(value, ...keys);
  return typeof leaf === "string" ? leaf : undefined;
}

/**
 * Pull the bare lowercase `local@domain` out of a `From:`-style header,
 * unwrapping a `"Display Name <addr>"` form when present and dropping anything
 * with no `@`. Returns `null` for empty/garbage input.
 *
 * The single source of truth for self-mail matching (issue #211): the Gmail
 * ingestion guard (`isSelfAuthored`) and the self-mail retirement backfill both
 * route through this so they match exactly the same set — display-name-aware,
 * exact-address, never a substring of display text. Keep behaviour pinned: a
 * change here silently widens or narrows what gets dropped/retired.
 */
export function parseEmailAddress(value: string | null | undefined): string | null {
  if (!value) return null;
  const raw = (value.match(/<([^>]+)>/)?.[1] ?? value).trim().toLowerCase();
  return raw.includes("@") ? raw : null;
}
