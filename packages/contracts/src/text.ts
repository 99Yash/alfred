/** Display-text folds. Not in `sanitize.ts` because nothing here is a safety guard. */

/**
 * Collapse whitespace runs to one space and trim. Display text only: this may
 * change, so keys, hashes, and dedup tokens keep their own fold, as
 * `loop-key.ts`'s `normalizeSubject` does.
 */
export function collapseWhitespace(text: string): string {
  // drift-ok: the one definition the `hand-rolled-whitespace-collapse` rule names.
  return text.replace(/\s+/g, " ").trim();
}
