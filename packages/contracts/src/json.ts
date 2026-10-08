/** JSON parsing that returns `unknown` or a validated value. Never `JSON.parse(raw) as T`. */

import type { z } from "zod";
import type { JsonValue } from "./user-model";

/**
 * `JSON.parse` that returns `unknown`, and `null` on malformed input.
 * Valid `"null"` also returns `null`; check the raw string if that matters.
 */
export function safeJsonParse(raw: string): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

/** Parse and validate. Returns `fallback` (default `null`) on bad JSON or a schema miss. Never throws. */
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

/** Make a value JSON-safe. `undefined` becomes `null`; cycles and BigInt become `{ unserializable }`. */
export function toJsonValue(value: unknown): JsonValue {
  if (value === undefined) return null;

  try {
    // SAFETY: text from `JSON.stringify` parses back to a plain JSON value.
    return JSON.parse(JSON.stringify(value)) as JsonValue;
  } catch {
    return { unserializable: String(value) };
  }
}
