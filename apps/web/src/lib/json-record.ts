import {
  isNonEmptyString,
  jsonObjectSchema,
  type JsonObject,
  type JsonValue,
} from "@alfred/contracts";

export type JsonRecord = JsonObject;

export function asRecord(value: unknown): JsonRecord | null {
  const parsed = jsonObjectSchema.safeParse(value);

  return parsed.success ? parsed.data : null;
}

/**
 * Coerce an untyped JSON leaf to a usable string, else `undefined` — the common
 * "read this field off a best-effort parsed blob, keep only a non-empty string"
 * shape. Wraps the shared {@link isNonEmptyString} guard so the emptiness rule
 * lives in one place instead of a local copy per card module.
 */
export function asString(value: unknown): string | undefined {
  return isNonEmptyString(value) ? value : undefined;
}

/**
 * Read a numeric leaf off a best-effort parsed record — the numeric
 * counterpart to {@link asString}. Only a finite number qualifies; a missing,
 * non-numeric, or non-finite leaf yields `undefined` rather than `NaN`. Takes
 * the closed `JsonValue` union (plus the `undefined` an absent key reads as
 * under `noUncheckedIndexedAccess`) instead of `unknown`, so the ~10 record-
 * leaf call sites prove they are reading parsed JSON, not arbitrary values.
 */
export function asNumber(value: JsonValue | undefined): number | undefined {
  return isFiniteNumber(value) ? value : undefined;
}

/**
 * True for a finite number — the predicate behind {@link asNumber}. The
 * `typeof` lives here, inside the guard, so the leaf reader stays free of
 * ad-hoc narrowing.
 */
function isFiniteNumber(value: JsonValue | undefined): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

export function parseJsonRecord(value: string | undefined): JsonRecord | null {
  if (!value) return null;

  try {
    return asRecord(JSON.parse(value));
  } catch {
    return null;
  }
}
