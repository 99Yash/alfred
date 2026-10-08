/**
 * The line a cold-start run writes when it finds no public profile, and the bar that
 * `buildUserContextLine` uses to skip it. One file, so the two cannot drift.
 * The run must write a sentence: an empty chunk fails `content.min(1)` at persist.
 * No imports: the triage read path must not load `@alfred/ai` for one string.
 */

/** The one line a run with no confident anchor and no findings writes. */
export const NO_PUBLIC_PROFILE_LINE = "No confident public profile was found.";

/** A line of only punctuation or whitespace is a header, not a prior. */
const HAS_ALPHANUMERIC_RE = /[\p{L}\p{N}]/u;

/**
 * A whole line that only says no public profile was found.
 * Both anchors, the verb set, and the 20-char tail bound work together.
 * A wider match silently drops a real prior. Short facts like
 * `No public profile located at Stripe` also drop, a known cost.
 */
const NO_PUBLIC_PROFILE_RE =
  /^no (?:confident )?public profile(?: (?:was|could be|is|has been))? (?:found|identified|located|available)\b[^.,;:]{0,20}[.!]?$/iu;

/**
 * True when a chunk holds a prior about the user. Folds whitespace first,
 * so a trailing newline cannot escape the `$` anchor.
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
 * Load-time controls for the pattern, sized to its boundaries. Only the controls
 * that must render catch a widened pattern; the refusal control alone does not.
 */
const GUARD_CASES = [
  { subject: NO_PUBLIC_PROFILE_LINE, holdsPrior: false },
  { subject: `${NO_PUBLIC_PROFILE_LINE} Works at Acme as a staff engineer.`, holdsPrior: true },
  { subject: `${NO_PUBLIC_PROFILE_STEM} beyond a GitHub page`, holdsPrior: true },
  { subject: "No public profile surfaced.", holdsPrior: true },
] satisfies readonly GuardCase[];

// Runs on import, so a broken pattern fails the first import, not every triage.
for (const { subject, holdsPrior } of GUARD_CASES) {
  if (holdsResearchPrior(subject) !== holdsPrior) {
    throw new Error(`NO_PUBLIC_PROFILE_RE no longer answers ${String(holdsPrior)} for: ${subject}`);
  }
}
