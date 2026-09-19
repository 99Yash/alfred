/**
 * The one sentence a cold-start run writes when it finds no confident public
 * profile, and the bar the triage prior reader applies before it spends prompt
 * bytes on the chunk.
 *
 * ONE reader applies this bar today: `buildUserContextLine`. The kind stays in
 * `USER_FACING_MEMORY_CHUNK_KINDS` (`knowledge/chunks.ts`), so the
 * `recent_memory` select in `knowledge/user-context.ts` and the `recallMemory`
 * default still render the same chunk unbarred. Campaign item 27 owns those two
 * doors; do not read this module as a bar the chunk carries everywhere.
 *
 * WHY the sentence and the bar share a file: the synthesis prompt asks for this
 * exact line (`synthesis.ts` rule 6) and `buildUserContextLine` refuses it. One
 * declaration means the two cannot drift. A run that finds nothing must still
 * write SOME content — `writeMemoryChunkArgsSchema.content` is
 * `z.string().min(1)`, so an empty synthesis throws at persist and fails the
 * whole run — so the empty answer is a sentence, not an empty string.
 *
 * This module imports nothing on purpose. The triage read path reaches it
 * through `user-context-line.ts`, and `synthesis.ts` value-imports `@alfred/ai`;
 * a shared constant declared there would drag the model client onto the read
 * path for one string.
 */

/** The one line a run with no confident anchor and no findings writes. */
export const NO_PUBLIC_PROFILE_LINE = "No confident public profile was found.";

/** A line of pure punctuation or whitespace is a research header, not a prior. */
const HAS_ALPHANUMERIC_RE = /[\p{L}\p{N}]/u;

/**
 * A whole line that only reports the absence of a profile.
 *
 * Anchored at BOTH ends, and its tail is bounded to 40 characters that hold no
 * `.`, `,`, `;` or `:`. Both bounds matter, and neither is a content test:
 *
 * - The anchors mean a real telegraphic synthesis (~300 words, many sentences)
 *   cannot match, because its later sentences fall outside the tail.
 * - The punctuation class and the 40-character length are what keep a SHORT
 *   real prior that OPENS with the absence phrase — "No public profile beyond a
 *   LinkedIn page; works at Acme as a staff engineer." — outside the pattern.
 *   {@link NO_PUBLIC_PROFILE_LINE} needs 10 tail characters and the stored
 *   paraphrase needs 31, so 40 is the smallest round bound that covers both.
 *
 * Keep both anchors and both bounds if this pattern is ever widened: a false
 * match drops a REAL prior with no error and no log, and the triage classifier
 * is simply less informed after it. Residual, in the other direction: a short
 * real prior that opens with the phrase and carries no `.`, `,`, `;` or `:` in
 * its first 40 characters is still dropped.
 *
 * It is a tier-3 guard: a wording it does not name still renders, and only a
 * reader notices.
 */
const NO_PUBLIC_PROFILE_RE = /^no (?:confident )?public profile\b[^.,;:]{0,40}[.!]?$/iu;

/**
 * True when a chunk carries a prior about the user. False for a line
 * of pure punctuation, and false for a whole line that only asserts no public
 * profile was found.
 *
 * Normalizes its input (whitespace runs folded to one space, trimmed) before
 * applying the anchored bar, so raw stored content with a trailing newline
 * cannot escape `/$/` and fail open. Idempotent: passing an already-collapsed
 * string answers the same as passing the raw chunk.
 */
export function holdsResearchPrior(content: string): boolean {
  const collapsed = content.replace(/\s+/g, " ").trim();

  if (!HAS_ALPHANUMERIC_RE.test(collapsed)) return false;

  return !NO_PUBLIC_PROFILE_RE.test(collapsed);
}

// The shared const pins the STRING the prompt asks for; the pattern above is a
// SECOND declaration that must keep refusing it. Verify at module load rather
// than trust the pair: an edit that narrows the pattern past the sentence fails
// the first import instead of rendering the placeholder on every classified
// email. Same timing and same shape as `assertToolNameRegistry` in `@alfred/ai`.
if (holdsResearchPrior(NO_PUBLIC_PROFILE_LINE)) {
  throw new Error("NO_PUBLIC_PROFILE_RE no longer refuses NO_PUBLIC_PROFILE_LINE");
}
