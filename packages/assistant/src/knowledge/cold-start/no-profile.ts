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
 * synthesis prompt writes: the singular subject `public profile`, an optional
 * copula, one of four report verbs, then a short tail of at most 20 characters
 * holding no `.`, `,`, `;` or `:`.
 *
 * The separator is the CONJUNCTION of the verb set and the tail bound. Neither
 * half separates a placeholder from a real prior alone, and both halves were
 * measured on the shipped pattern:
 *
 * - The verb set alone does not. `No confident public profile.` is a pure
 *   placeholder, carries no report verb, and RENDERS. `No public profile found
 *   beyond GitHub` carries the verb plus a real fact, and DROPS.
 * - The tail bound alone does not. Every escape named below sits well inside 20
 *   characters.
 *
 * One of those 20 characters is the space that separates the verb from whatever
 * follows, so the window holds 19 characters of text: a 19-character fact drops
 * and a 20-character fact renders. The window is therefore NOT limited to a
 * trailing decoration on the placeholder. It swallows any short fact, and that
 * is a real false REJECT: `No public profile located at Stripe`,
 * `No public profile identified in India` and `No public profile was found at
 * Acme Corp` all drop. `holdsResearchPrior` folds whitespace runs to one space
 * before it matches, so a NEWLINE also lands inside the window, and the
 * two-line chunk `"No public profile found\nActive on GitHub."` drops.
 *
 * The anchors keep a real telegraphic synthesis (~300 words, many sentences)
 * out, because its later sentences fall outside the window.
 *
 * The other direction fails OPEN, and the escapes are two classes rather than
 * one. Of seven measured placeholders that render, five carry no verb from the
 * set (`No confident public profile.`, `No public profile for this person.`,
 * `No confident public profile match.`, `No public profile was discovered.`,
 * `No public profile surfaced.`) and two miss the singular subject
 * (`No public profiles were found.`, `Nothing was found about this person.`).
 *
 * Keep both anchors, the verb set AND the tail bound if this pattern is ever
 * widened: a false match drops a REAL prior with no error and no log, and the
 * triage classifier is simply less informed after it.
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

type GuardCase = { readonly subject: string; readonly holdsPrior: boolean };

/**
 * The tracked record of what the pattern above was measured against, and the
 * load-time control that keeps each answer true.
 *
 * The shared const pins the STRING the prompt asks for; the pattern is a SECOND
 * declaration that must keep refusing that string AND keep admitting a real
 * prior built from it. A refusal control alone catches nothing: all 12 widenings
 * counted below still refuse the constant, so that control stays silent for
 * every one. Only a positive control derived from the same constant sees them.
 *
 * Each subject is sized to a boundary, not to a comfortable example:
 *
 * - the placeholder itself, which must refuse;
 * - the placeholder followed by a real fact, which must render — the `$` anchor
 *   and the `[^.,;:]` class;
 * - a tail of exactly 21 characters, one past the bound, which must render —
 *   any raised bound from 21 upward refuses it. A longer control has a blind
 *   band: the 43-character tail this file shipped in round 2 stayed silent at
 *   `{0,21}` through `{0,42}`, and `{0,40}` is the exact bound round 1 shipped
 *   and round 2 proved broken;
 * - a matching subject with a verb outside the set, which must render — a verb
 *   alternation widened to `\w+` refuses it.
 */
const GUARD_CASES = [
  { subject: NO_PUBLIC_PROFILE_LINE, holdsPrior: false },
  { subject: `${NO_PUBLIC_PROFILE_LINE} Works at Acme as a staff engineer.`, holdsPrior: true },
  { subject: `${NO_PUBLIC_PROFILE_STEM} beyond a GitHub page`, holdsPrior: true },
  { subject: "No public profile surfaced.", holdsPrior: true },
] satisfies readonly GuardCase[];

// Runs at module load rather than on trust: an edit that breaks any answer above
// fails the first import instead of dropping a prior on every classified email.
//
// Measured against 12 plausible widenings, this table catches 9: dropping the
// `$` anchor, replacing the tail with `.*`, and raising the tail bound to any of
// 21, 30, 40, 42, 43 or 400, plus widening the verb alternation to `\w+`.
//
// Three stay tier 5, with no control here: dropping the `^` anchor, widening the
// `[^.,;:]` character class, and widening the copula alternation. And the block
// runs on import and in `barrel-load.test.ts`, never in `pnpm check`.
//
// `assertToolNameRegistry` in `@alfred/ai` (`tool-name-codec.ts:37,74`) runs at
// the same timing. Its shape differs: it asserts a round trip from a named
// exported function, while this file is a bare top-level block.
for (const { subject, holdsPrior } of GUARD_CASES) {
  if (holdsResearchPrior(subject) !== holdsPrior) {
    throw new Error(`NO_PUBLIC_PROFILE_RE no longer answers ${String(holdsPrior)} for: ${subject}`);
  }
}
