/**
 * Rationale-length primitives shared by the classifier and its floors.
 *
 * Lives in its own leaf module (no imports from `classify.ts` or `floors/`) so
 * both the classifier orchestration and the deterministic floors can truncate a
 * rationale without a `classify.ts ↔ floors/` import cycle. Re-exported from
 * `classify.ts` for the existing public importers (`deepen.ts`, the barrel).
 */

/** Hard cap on a stored rationale — matches the schema's `.max()` and the model's `maxOutputTokens`. */
export const MAX_RATIONALE_LEN = 500;

/** Truncate a rationale to {@link MAX_RATIONALE_LEN}, appending an ellipsis. PURE. */
export function truncateRationale(value: string): string {
  return value.length > MAX_RATIONALE_LEN ? `${value.slice(0, MAX_RATIONALE_LEN - 3)}...` : value;
}
