/**
 * Display-text folds. Browser-safe, pure string work.
 *
 * Deliberately NOT in `sanitize.ts`: that module is the ADR-0070 persistence
 * poison boundary, and a display fold sitting beside `sanitizeToolResult` reads
 * as a safety primitive to the next author. Nothing here protects a sink.
 */

/**
 * Collapse every run of whitespace to one space and trim the ends.
 *
 * **Display text only.** The output is rendered to a person or handed to a
 * model as prose. It must never build a key, a hash, a dedup token or a
 * classifier input, because this fold is free to change whenever the display
 * improves and a stored identity is not. `loop-key.ts`'s `normalizeSubject`
 * keeps its own private copy for exactly that reason.
 *
 * Not the same job as `context-search/pack.ts`'s `oneLine`, which folds only
 * the four ECMAScript line terminators plus the space/tab run each removal
 * leaves, on purpose: a packed record must stay on one line while keeping the
 * provider's own typography (`U+00A0`, `U+3000`, a lone tab). A display snippet
 * wants those folded so the preview reads as one glance. Two jobs, two folds —
 * do not merge them.
 */
export function collapseWhitespace(text: string): string {
  // drift-ok: the one definition the `hand-rolled-whitespace-collapse` rule names.
  return text.replace(/\s+/g, " ").trim();
}
