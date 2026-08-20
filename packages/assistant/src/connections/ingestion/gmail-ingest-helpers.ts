import { sha256 } from "@alfred/corpus";

/**
 * Single owner for `sha256` is `@alfred/corpus` — this re-export keeps
 * the import path stable for call sites that already import from helpers.
 */
export { sha256 };

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
