import { createHash } from "node:crypto";

/**
 * SHA-256 hex digest of a string — the content hash for documents.
 * Single home for the helper previously duplicated in gmail-ingest.ts and
 * gmail-attachment.ts.
 */
export function sha256(input: string): string {
  return createHash("sha256").update(input).digest("hex");
}

/**
 * Convert Gmail's `internalDate` (ms-since-epoch as string) to a Date.
 * Returns null when missing or non-numeric — the column is nullable.
 */
export function internalDateToDate(internalDate: string | undefined): Date | null {
  if (!internalDate) return null;
  const ms = Number(internalDate);
  if (!Number.isFinite(ms)) return null;
  return new Date(ms);
}
