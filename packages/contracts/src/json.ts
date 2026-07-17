/**
 * Safe JSON parsing — the server analog of the type-safe localStorage reader
 * in `apps/web/src/lib/storage.ts`.
 *
 * The lesson from that module: `JSON.parse` returns `any`, so
 * `JSON.parse(raw) as T` is a blind cast that both throws on malformed input
 * *and* lies about the shape of whatever did parse. The storage reader fixed it
 * by parsing to `unknown` and running the value through a Zod schema —
 * valid-or-default, never throws. These helpers carry that same shape to the
 * server (Redis caches, signed-state blobs, anything deserialized from a
 * string we don't fully control).
 */

import type { z } from "zod";

/**
 * `JSON.parse` that returns `unknown` instead of `any`, and `null` instead of
 * throwing on malformed input. Narrow the result with a guard (`isRecord`,
 * `Array.isArray`, …) or a schema — never trust the parsed shape.
 *
 * Note `null` is also what valid JSON `"null"` parses to; callers that need to
 * tell "absent/corrupt" from "literal null" should guard on the raw string
 * first (see how `sender-priors` uses a `"null"` sentinel).
 */
export function safeJsonParse(raw: string): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

/**
 * Parse a JSON string and validate it against a Zod schema in one step. Returns
 * the validated value, or `fallback` (default `null`) when the JSON is
 * malformed or fails the schema. Never throws — corrupt input degrades to the
 * fallback rather than blowing up the caller.
 */
export function parseJsonWith<T>(raw: string, schema: z.ZodType<T>): T | null;
export function parseJsonWith<T>(raw: string, schema: z.ZodType<T>, fallback: T): T;
export function parseJsonWith<T>(
  raw: string,
  schema: z.ZodType<T>,
  fallback: T | null = null,
): T | null {
  const result = schema.safeParse(safeJsonParse(raw));
  return result.success ? result.data : fallback;
}

/**
 * Coerce an arbitrary value into a JSON-safe one for storage on a transcript or
 * tool-result message: `undefined` becomes `null`, and anything that can't
 * round-trip through `JSON.stringify` (cycles, BigInt, …) degrades to a
 * `{ unserializable }` marker rather than throwing.
 */
export function toJsonValue(value: unknown): unknown {
  if (value === undefined) return null;
  try {
    return JSON.parse(JSON.stringify(value)) as unknown;
  } catch {
    return { unserializable: String(value) };
  }
}
