export type JsonRecord = Record<string, unknown>;

export function asRecord(value: unknown): JsonRecord | null {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as JsonRecord) : null;
}

export function parseJsonRecord(value: string | undefined): JsonRecord | null {
  if (!value) return null;
  try {
    return asRecord(JSON.parse(value) as unknown);
  } catch {
    return null;
  }
}
