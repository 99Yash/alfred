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
 * Anchored at BOTH ends, and its middle names the absence VOCABULARY the
 * synthesis prompt writes: the subject `public profile`, an optional copula,
 * then one of four report verbs. The verb is what separates a placeholder from
 * a real prior, because a prior that opens with the same subject continues into
 * a fact instead — `No confident public profile beyond GitHub 99Yash` carries no
 * report verb and renders.
 *
 * After the verb the pattern allows at most 20 characters holding no `.`, `,`,
 * `;` or `:`. That window is for a trailing decoration on the placeholder
 * itself (` online`, ` for this person`), not for content. The anchors keep a
 * real telegraphic synthesis (~300 words, many sentences) out, because its later
 * sentences fall outside the window.
 *
 * Measured on the shipped pattern: 9 placeholder wordings refuse, 8 real priors
 * render, including the two short priors the campaign review named. The false
 * REJECT window is now 20 characters wide — a prior reading
 * `No public profile found <=20 characters of fact with no . , ; :` still drops,
 * and 21 characters render. The other direction fails OPEN: a placeholder that
 * reports absence with a verb outside the four, such as
 * `No public profile surfaced.`, renders.
 *
 * Keep both anchors and the verb set if this pattern is ever widened: a false
 * match drops a REAL prior with no error and no log, and the triage classifier
 * is simply less informed after it.
 *
 * It is a tier-3 guard: a wording it does not name still renders, and only a
 * reader notices.
 */
const NO_PUBLIC_PROFILE_RE =
  /^no (?:confident )?public profile(?: (?:was|could be|is|has been))? (?:found|identified|located|available)\b[^.,;:]{0,20}[.!]?$/iu;

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

/** {@link NO_PUBLIC_PROFILE_LINE} without its terminal punctuation. */
const NO_PUBLIC_PROFILE_STEM = NO_PUBLIC_PROFILE_LINE.replace(/[.!]$/u, "");

// The shared const pins the STRING the prompt asks for; the pattern above is a
// SECOND declaration that must keep refusing that string AND keep admitting a
// real prior built from it. Both directions run at module load rather than on
// trust: an edit that breaks either one fails the first import instead of
// dropping a prior on every classified email.
//
// The refusal control alone is the cheap half. Measured against four plausible
// widenings, it catches none; the two positive controls catch three — drop the
// `$` anchor, replace the tail with `.*`, raise the tail bound to 400.
//
// Two gaps stay tier 5, with no control here: dropping the `^` anchor, and
// widening the `[^.,;:]` character class. And the guard runs on import and in
// `barrel-load.test.ts`, never in `pnpm check`.
//
// `assertToolNameRegistry` in `@alfred/ai` (`tool-name-codec.ts:36,73`) runs at
// the same timing. Its shape differs: it asserts a round trip from a named
// exported function, while this file is a bare top-level block.
if (holdsResearchPrior(NO_PUBLIC_PROFILE_LINE)) {
  throw new Error("NO_PUBLIC_PROFILE_RE no longer refuses NO_PUBLIC_PROFILE_LINE");
}

for (const prior of [
  `${NO_PUBLIC_PROFILE_LINE} Works at Acme as a staff engineer.`,
  `${NO_PUBLIC_PROFILE_STEM} beyond a GitHub page and a conference talk`,
]) {
  if (!holdsResearchPrior(prior)) {
    throw new Error(`NO_PUBLIC_PROFILE_RE now refuses a real prior: ${prior}`);
  }
}
