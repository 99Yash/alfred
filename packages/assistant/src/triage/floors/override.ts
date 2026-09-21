import type { TriageClassification } from "../classify";
import type { FloorResult } from "./floor";

/**
 * The rule-15a boilerplate hedge, blanked before either exposure predicate runs.
 *
 * A vendor self-echo — a one-time code, a reset link, an OAuth-app notice —
 * closes with "if you did not do this, your account may be compromised". Rule
 * 15a declares that sentence ZERO signal: it appears identically on a legitimate
 * echo and on a phish, so the account's own vendor asserts nothing about who
 * acted. The exposure verb in it is bound to `account`, never to the secret the
 * mail carries.
 *
 * `EXPOSURE_GAP` below now enforces that binding on its own for the common
 * shape, because a period separates the hedge from the code line. This blank
 * covers the shape the gap rule cannot: the same hedge with a LINE BREAK instead
 * of a period, where "…may be compromised\nYour token is 419283" leaves the verb
 * one word from the secret. Both are ordinary in plain-text vendor mail, so the
 * two rules are kept together rather than traded.
 *
 * Blanking is the narrowest cut that keeps the real signals: an exposure verb
 * whose object IS the secret ("your api key was leaked", "GitGuardian detected an
 * exposed API key in commit a1b2c3") is untouched, and so is an account
 * compromise asserted alongside a named secret, because that body carries a
 * second verb. The replacement pads to the SAME length so no surviving noun and
 * verb are drawn closer together by the edit.
 *
 * `g` is safe here because the regex is only ever handed to `String.replace`,
 * which resets `lastIndex`; never call `.test` on it.
 */
const SELF_ECHO_ACCOUNT_COMPROMISE_RE = new RegExp(
  String.raw`\b(?:(?:your|the|this)\s+account\s+(?:(?:may|might|could)\s+)?(?:(?:have|has|had)\s+)?(?:been\s+)?(?:be\s+|was\s+|is\s+)?compromised|compromis(?:ed|ing)\s+(?:your|the|this)\s+account)\b`,
  "gi",
);

function withoutSelfEchoBoilerplate(text: string): string {
  return text.replace(SELF_ECHO_ACCOUNT_COMPROMISE_RE, (match) => " ".repeat(match.length));
}

/**
 * Exposure predicates (ADR-0051 §5, Phase 3 seed = ONE signal). Both key on
 * EXPOSURE VERBS, deliberately narrower than the broad `hasSecurityKeyword`
 * content flag — a self-initiated "sign in"/"your code is 123456" link contains
 * none of these verbs, so it never trips them (the bug that opened v3). The two
 * must also stand in ONE unbroken phrase — see `EXPOSURE_GAP` — which is what
 * stops an exposure verb aimed at something else in the same paragraph from
 * reading as a claim about the secret.
 *
 * Both noun sets are narrower than `hasSecurityKeyword` ON PURPOSE: the generic
 * `credential` is excluded from both (it stays in the broad hint regex) because
 * "the credential object is exposed to the network" is ordinary engineering
 * prose that satisfies every gap rule this module can state.
 *
 * The two sets differ on `password`, and the difference is the whole point of
 * having two. They answer opposite questions with opposite error costs:
 *
 *   FLOOR (`matchesExposedSecret`)   "is this CERTAINLY a leaked machine
 *                                     credential?" It force-tags `urgent`
 *                                     unrecoverably, so it wants precision, and
 *                                     `password` sits inside ordinary vendor auth
 *                                     prose. Measured: keeping `password` made the
 *                                     floor backwards for that class — it fired on
 *                                     "Your Wellfound password was changed. If you
 *                                     did not make this change, your account may be
 *                                     compromised" and stayed silent on "Critical
 *                                     security alert: a new device signed in … from
 *                                     an unrecognized location".
 *
 *   VETO (`matchesExposedCredentialClaim`)  "does this body PLAUSIBLY name an
 *                                     exposed credential?" Its six callers all
 *                                     PRESERVE a category or a rail todo the model
 *                                     already chose, so a miss buries a live
 *                                     exposure and it wants recall. `password`
 *                                     belongs: "a database password committed to
 *                                     a public repo", a broadcast alarm naming an
 *                                     exposed production database password, and
 *                                     "your password was found in a data breach"
 *                                     are all real. Write the example as prose,
 *                                     not as `DB_PASSWORD` — `_` is a word
 *                                     character, so no `\b` opens before the noun
 *                                     and the identifier form never matches.
 *
 * Before #1188 one regex answered both, so tightening the floor silently relaxed
 * the six vetoes. Change a noun set only after deciding WHICH question it answers.
 */
const OVERRIDE_FLOOR_SECRET_NOUN = String.raw`(?:secret|api[ -]?key|token|private key)`;

const EXPOSED_CREDENTIAL_NOUN = String.raw`(?:secret|api[ -]?key|token|private key|password)`;

const OVERRIDE_FLOOR_EXPOSURE_VERB = String.raw`(?:exposed|leaked|committed|compromised|found|detected)`;

/**
 * One word of the run that may sit between the secret and the exposure verb: a
 * plain word, or a bracketed aside, because leak bots write the credential's
 * identity in parentheses ("A secret (Redis connection URI) was found exposed").
 */
const EXPOSURE_GAP_WORD = String.raw`(?:\([^()\n]*\)|\[[^\]\n]*\]|[\w'’-]+)`;

/**
 * The gap the two must share: at most three words, separated by whitespace
 * ALONE. Whitespace-only is what binds the verb to the secret. Any other
 * character — a period, a comma, a colon, a URL delimiter — ends the run, so the
 * verb and the noun must stand in one unbroken phrase rather than merely in the
 * same paragraph.
 *
 * This replaced a 100-character dotall window that read the two as one signal
 * whenever they shared a neighbourhood, which is how the floor force-tagged the
 * exact class rule 15a demotes. Both halves of the gap rule carry weight, and
 * each one alone lets a real self-echo through:
 *
 *   "We found your account associated with this email. Your password reset
 *    token is abc123."          — blocked by the sentence break, 5 words apart
 *   "we detected this login attempt and sent you a verification token."
 *                               — no punctuation at all; blocked by the 3-word cap
 *   "We are committed to protecting your account. Your one-time token is 419283."
 *                               — blocked by both
 *
 * Three words, not one, because a real exposure names the credential with its
 * own modifiers: "found a hard-coded API key", "an exposed production database
 * password", "the aws secret access key was committed". An auxiliary verb is
 * just another word in the run, so "an api key was leaked" needs no separate
 * rule.
 *
 * This is a proximity rule with a clause barrier, not a parse. It cannot see
 * that "your token expires soon, nothing was compromised" is a denial. What it
 * does guarantee is that the verb and the secret belong to one phrase, which is
 * the property the old window lacked.
 */
const EXPOSURE_GAP = String.raw`(?:\s+${EXPOSURE_GAP_WORD}){0,3}\s+`;

function exposureRe(noun: string): RegExp {
  return new RegExp(
    String.raw`\b(?:${noun}\b${EXPOSURE_GAP}${OVERRIDE_FLOOR_EXPOSURE_VERB}|${OVERRIDE_FLOOR_EXPOSURE_VERB}\b${EXPOSURE_GAP}${noun})\b`,
    "i",
  );
}

const OVERRIDE_FLOOR_SECRET_RE = exposureRe(OVERRIDE_FLOOR_SECRET_NOUN);

const EXPOSED_CREDENTIAL_RE = exposureRe(EXPOSED_CREDENTIAL_NOUN);

const OVERRIDE_FLOOR_CONFIDENCE_FLOOR = 0.85;

/**
 * True when the signal text carries an exposed/leaked/committed MACHINE secret —
 * the one unambiguous severity signal the override floor forces `urgent` on. The
 * precision half of the pair above. Exposed as a predicate (not the raw regex) so
 * the floor and the classifier's `floorMatches` conflict gate stay the SAME
 * question: the gate exists only to skip a re-ask the floor will overrule, so it
 * must never be true where the floor is silent. PURE.
 */
export function matchesExposedSecret(text: string): boolean {
  return OVERRIDE_FLOOR_SECRET_RE.test(withoutSelfEchoBoilerplate(text));
}

/**
 * True when the signal text plausibly names an exposed credential of any kind,
 * including a user password. The recall half of the pair above, for the six
 * carve-outs that PRESERVE a category or a rail todo — `hasIntrinsicStakeSignal`,
 * the PR-gate liveness escape and the tracker-owned escape in `classify.ts`, and
 * the three demotion vetoes in `sender-kind.ts`. Never use it to ESCALATE. PURE.
 */
export function matchesExposedCredentialClaim(text: string): boolean {
  return EXPOSED_CREDENTIAL_RE.test(withoutSelfEchoBoilerplate(text));
}

/**
 * Override floor (ADR-0051 §5, Phase 3 seed = ONE signal). Forces `urgent` when
 * an exposed/leaked/committed secret is present, regardless of model output.
 * PURE. The only floor that ESCALATES; whether it fired is `verdict.kind`, and
 * `matched` is the fact the verdict cannot carry — the signal was present but
 * the model had already said `urgent`, so there was nothing to force.
 */
export function applyOverrideFloor(
  classification: TriageClassification,
  signalText: string,
): FloorResult & { matched: boolean } {
  if (!matchesExposedSecret(signalText)) {
    return { verdict: { kind: "keep" }, matched: false };
  }

  if (classification.category === "urgent") {
    // Floor agrees with the model — no change, nothing to force.
    return { verdict: { kind: "keep" }, matched: true };
  }

  return {
    verdict: {
      kind: "escalate",
      to: "urgent",
      confidenceFloor: OVERRIDE_FLOOR_CONFIDENCE_FLOOR,
      reason: "Override floor: exposed secret material was detected — forced urgent.",
    },
    matched: true,
  };
}
