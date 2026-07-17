import { isNonEmptyString, isRecord } from "@alfred/contracts";

export type JsonRecord = Record<string, unknown>;

export function asRecord(value: unknown): JsonRecord | null {
  return isRecord(value) ? value : null;
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

export function parseJsonRecord(value: string | undefined): JsonRecord | null {
  if (!value) return null;
  try {
    return asRecord(JSON.parse(value) as unknown);
  } catch {
    return null;
  }
}
