import {
  isNonEmptyString,
  jsonObjectSchema,
  type JsonObject,
  type JsonValue,
} from "@alfred/contracts";

export function asRecord(value: unknown): JsonObject | null {
  const parsed = jsonObjectSchema.safeParse(value);

  return parsed.success ? parsed.data : null;
}

/** A non-empty string, else `undefined`. */
export function asString(value: unknown): string | undefined {
  return isNonEmptyString(value) ? value : undefined;
}

/** A finite number, else `undefined`. Takes `JsonValue`, not `unknown`, so callers pass parsed JSON. */
export function asNumber(value: JsonValue | undefined): number | undefined {
  return isFiniteNumber(value) ? value : undefined;
}

function isFiniteNumber(value: JsonValue | undefined): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

export function parseJsonRecord(value: string | undefined): JsonObject | null {
  if (!value) return null;

  try {
    return asRecord(JSON.parse(value));
  } catch {
    return null;
  }
}
