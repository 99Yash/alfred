import { isRecord } from "@alfred/contracts";

export type JsonRecord = Record<string, unknown>;

export function asRecord(value: unknown): JsonRecord | null {
  return isRecord(value) ? value : null;
}

export function parseJsonRecord(value: string | undefined): JsonRecord | null {
  if (!value) return null;
  try {
    return asRecord(JSON.parse(value) as unknown);
  } catch {
    return null;
  }
}
