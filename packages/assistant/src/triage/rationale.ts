/** A leaf module, so `classify.ts` and `floors/` share it without a cycle. */

/** Matches the schema's `.max()`. */
export const MAX_RATIONALE_LEN = 500;

export function truncateRationale(value: string): string {
  return value.length > MAX_RATIONALE_LEN ? `${value.slice(0, MAX_RATIONALE_LEN - 3)}...` : value;
}
