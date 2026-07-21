import type { TriageClassification } from "../classify";
import { truncateRationale } from "../rationale";

/**
 * Override-floor predicate (ADR-0051 §5, Phase 3 seed = ONE signal). Keys on
 * EXPOSURE VERBS, deliberately narrower than the broad `hasSecurityKeyword`
 * content flag — a self-initiated "sign in"/"your code is 123456" link contains
 * none of these verbs, so it never trips the floor (the bug that opened v3).
 * `[\s\S]` (dotall) so the noun and verb can wrap onto separate lines, as
 * security-bot bodies do.
 *
 * The noun set is narrower than `hasSecurityKeyword` ON PURPOSE: the generic
 * `credential` is excluded here (it stays in the broad hint regex) because
 * `credential` + `exposed` over an 80-char window matches ordinary engineering
 * prose ("the credential object is exposed to the network") and the floor is
 * unrecoverable — a false positive force-tags an architecture email `urgent`.
 */
const OVERRIDE_FLOOR_SECRET_NOUN = String.raw`(?:secret|api[ -]?key|token|private key|password)`;
const OVERRIDE_FLOOR_EXPOSURE_VERB = String.raw`(?:exposed|leaked|committed|compromised|found|detected)`;
const OVERRIDE_FLOOR_SECRET_RE = new RegExp(
  String.raw`\b(?:${OVERRIDE_FLOOR_SECRET_NOUN}\b[\s\S]{0,100}\b${OVERRIDE_FLOOR_EXPOSURE_VERB}|${OVERRIDE_FLOOR_EXPOSURE_VERB}\b[\s\S]{0,100}\b${OVERRIDE_FLOOR_SECRET_NOUN})\b`,
  "i",
);

const OVERRIDE_FLOOR_CONFIDENCE_FLOOR = 0.85;

/**
 * True when the signal text carries an exposed/leaked/committed secret — the one
 * unambiguous severity signal the override floor forces `urgent` on. Exposed as a
 * predicate (not the raw regex) so the classifier's conflict nets, the sibling
 * floors' secret-carve-outs, and the rail's cold-sender stake test share ONE
 * exposed-secret definition. PURE.
 */
export function matchesExposedSecret(text: string): boolean {
  return OVERRIDE_FLOOR_SECRET_RE.test(text);
}

/**
 * Override floor (ADR-0051 §5, Phase 3 seed = ONE signal). Forces `urgent` when
 * an exposed/leaked/committed secret is present, regardless of model output.
 * PURE. Returns the (possibly forced) classification and whether it changed.
 */
export function applyOverrideFloor(
  classification: TriageClassification,
  signalText: string,
): { classification: TriageClassification; matched: boolean; forced: boolean } {
  if (!OVERRIDE_FLOOR_SECRET_RE.test(signalText)) {
    return { classification, matched: false, forced: false };
  }
  if (classification.category === "urgent") {
    // Floor agrees with the model — no change, nothing to force.
    return { classification, matched: true, forced: false };
  }
  return {
    classification: {
      ...classification,
      category: "urgent",
      confidence: Math.max(classification.confidence, OVERRIDE_FLOOR_CONFIDENCE_FLOOR),
      rationale: truncateRationale(
        `${classification.rationale} Override floor: exposed secret material was detected — forced urgent.`,
      ),
    },
    matched: true,
    forced: true,
  };
}
