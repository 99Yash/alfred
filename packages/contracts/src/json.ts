/** JSON parsing that returns a `JsonValue` or a validated value. Never `JSON.parse(raw) as T`. */

import type { z } from "zod";

import { toMessage } from "./errors";
import type { JsonValue } from "./user-model";

/**
 * `JSON.parse`, typed as what it builds. Without a reviver it can only produce JSON values.
 * Throws a `SyntaxError` on malformed input. Use it when malformed input needs its own
 * branch; otherwise use `safeJsonParse` or `parseJsonWith`.
 */
export function parseJsonText(raw: string): JsonValue {
  // oxlint-disable-next-line typescript/no-unsafe-return -- lib.es5 types JSON.parse as `any`; with no reviver it builds only JSON values, and this is the one site that states that.
  return JSON.parse(raw);
}

/**
 * `parseJsonText` that returns `null` on malformed input instead of throwing.
 * Valid `"null"` also returns `null`; check the raw string if that matters.
 */
export function safeJsonParse(raw: string): JsonValue {
  try {
    return parseJsonText(raw);
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

/**
 * Make a value JSON-safe. `undefined` becomes `null`. A value `JSON.stringify` refuses (a cycle,
 * a BigInt) becomes `{ unserializable }` with the refusal's message.
 */
export function toJsonValue(value: unknown): JsonValue {
  if (value === undefined) return null;

  try {
    return parseJsonText(JSON.stringify(value));
  } catch (error) {
    return { unserializable: toMessage(error) };
  }
}
