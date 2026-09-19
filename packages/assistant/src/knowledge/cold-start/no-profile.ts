/**
 * The one sentence a cold-start run writes when it finds no confident public
 * profile, and the bar every reader of a `cold_start_research` chunk applies
 * before it spends prompt bytes on the chunk.
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
 * Anchored at BOTH ends, and its tail is bounded to 80 period-free characters,
 * so a real telegraphic synthesis (~300 words, many sentences) is structurally
 * ineligible to match however it opens. Keep both anchors and the bound if this
 * pattern is ever widened: a false match drops a REAL prior with no error and
 * no log, and the triage classifier is simply less informed after it.
 *
 * The bound covers {@link NO_PUBLIC_PROFILE_LINE} plus the paraphrase family
 * already stored by earlier prompt versions ("No public profile could be found
 * for this person."). It is a tier-3 guard: a wording it does not name still
 * renders, and only a reader notices.
 */
const NO_PUBLIC_PROFILE_RE = /^no (?:confident )?public profile\b[^.]{0,80}[.!]?$/iu;

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
