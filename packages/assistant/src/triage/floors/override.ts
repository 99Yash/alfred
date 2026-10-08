import type { TriageClassification } from "../classify";
import type { FloorResult } from "./floor";

/**
 * Blanks the rule-15a hedge "your account may be compromised" before both predicates.
 * `EXPOSURE_GAP` stops it after a period; this covers a line break before the secret.
 * Pads to the same length so no words move closer. `g` is safe only with `replace`; never `.test`.
 */
const SELF_ECHO_ACCOUNT_COMPROMISE_RE = new RegExp(
  String.raw`\b(?:(?:your|the|this)\s+account\s+(?:(?:may|might|could)\s+)?(?:(?:have|has|had)\s+)?(?:been\s+)?(?:be\s+|was\s+|is\s+)?compromised|compromis(?:ed|ing)\s+(?:your|the|this)\s+account)\b`,
  "gi",
);

function withoutSelfEchoBoilerplate(text: string): string {
  return text.replace(SELF_ECHO_ACCOUNT_COMPROMISE_RE, (match) => " ".repeat(match.length));
}

/**
 * Two exposure predicates with opposite error costs (#1188). Change a noun set
 * only after you decide which one it serves. Neither has bare `credential`.
 *   FLOOR (`matchesExposedSecret`): forces `urgent`, so precision. No `password`:
 *     it fired on "your password was changed" vendor echoes.
 *   VETO (`matchesExposedCredentialClaim`): only preserves a category or todo, so
 *     recall. Has `password`. `DB_PASSWORD` never matches: `_` blocks the `\b`.
 */
const OVERRIDE_FLOOR_SECRET_NOUN = String.raw`(?:secret|api[ -]?key|token|private key)`;

const EXPOSED_CREDENTIAL_NOUN = String.raw`(?:secret|api[ -]?key|token|private key|password)`;

const OVERRIDE_FLOOR_EXPOSURE_VERB = String.raw`(?:exposed|leaked|committed|compromised|found|detected)`;

/** Leak bots name the secret in brackets ("A secret (Redis connection URI) was found"). */
const EXPOSURE_BRACKETED_ASIDE = String.raw`(?:\([^()\n]*\)|\[[^\]\n]*\])`;

const EXPOSURE_GAP_WORD = String.raw`(?:${EXPOSURE_BRACKETED_ASIDE}|[\w'’-]+)`;

/** Recall only: a bracketed aside may end in a comma. A comma after a plain word opens a clause. */
const EXPOSURE_GAP_WORD_RECALL = String.raw`(?:${EXPOSURE_BRACKETED_ASIDE},?|[\w'’-]+)`;

/**
 * Precision gap: at most three words, whitespace only. Any punctuation ends the
 * run, so verb and secret must share one phrase ("We found your account. Your
 * reset token is…" does not match). Three words fit "an exposed production
 * database password". A proximity rule, not a parse: it cannot see a denial.
 */
const EXPOSURE_GAP = String.raw`(?:\s+${EXPOSURE_GAP_WORD}){0,3}\s+`;

/**
 * A comma pair around up to six words ("Your token, which grants API access, was leaked").
 * Both commas required: one comma let "We found your account, and your password reset token" match.
 */
const EXPOSURE_SET_OFF_CLAUSE = String.raw`,(?:\s+${EXPOSURE_GAP_WORD_RECALL}){0,6}\s*,`;

/** Recall gap: the precision gap plus at most one comma-pair clause. */
const EXPOSURE_GAP_RECALL = String.raw`(?:\s+${EXPOSURE_GAP_WORD_RECALL}){0,3}(?:${EXPOSURE_SET_OFF_CLAUSE}(?:\s+${EXPOSURE_GAP_WORD_RECALL}){0,3})?\s+`;

function exposureRe(noun: string, gap: string): RegExp {
  return new RegExp(
    String.raw`\b(?:${noun}\b${gap}${OVERRIDE_FLOOR_EXPOSURE_VERB}|${OVERRIDE_FLOOR_EXPOSURE_VERB}\b${gap}${noun})\b`,
    "i",
  );
}

const OVERRIDE_FLOOR_SECRET_RE = exposureRe(OVERRIDE_FLOOR_SECRET_NOUN, EXPOSURE_GAP);

const EXPOSED_CREDENTIAL_RE = exposureRe(EXPOSED_CREDENTIAL_NOUN, EXPOSURE_GAP_RECALL);

const OVERRIDE_FLOOR_CONFIDENCE_FLOOR = 0.85;

/**
 * A leaked machine secret; the floor forces `urgent` on it. `classifyEmail` uses
 * the same predicate for `floorMatches`, so the gate is never true where the floor is silent.
 */
export function matchesExposedSecret(text: string): boolean {
  return OVERRIDE_FLOOR_SECRET_RE.test(withoutSelfEchoBoilerplate(text));
}

/**
 * Any plausibly exposed credential, `password` included. Only for the six
 * carve-outs that preserve a category or todo. Never use it to escalate.
 */
export function matchesExposedCredentialClaim(text: string): boolean {
  return EXPOSED_CREDENTIAL_RE.test(withoutSelfEchoBoilerplate(text));
}

/**
 * Forces `urgent` on an exposed secret (ADR-0051 §5). The only escalating floor.
 * `matched` covers the case the verdict cannot: the model already said `urgent`.
 */
export function applyOverrideFloor(
  classification: TriageClassification,
  signalText: string,
): FloorResult & { matched: boolean } {
  if (!matchesExposedSecret(signalText)) {
    return { verdict: { kind: "keep" }, matched: false };
  }

  if (classification.category === "urgent") {
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
