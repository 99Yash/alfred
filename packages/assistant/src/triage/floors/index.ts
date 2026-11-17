import { applyFloorVerdict, type FloorResult } from "./floor";
import type { TriageClassification } from "../classify";
import { applyOverrideFloor } from "./override";

/**
 * Deterministic floors after the model (ADR-0051 §5). The prompt owns judgment; the floor
 * guarantees one case the theory gives to code ("What code decides" 3, the security check):
 *   - override — an exposed secret escalates to `urgent`.
 * The sender-kind and meeting demotions of ADR-0051 left in slice 3: their cases are evidence
 * lines in the prompt now (theory, "The evidence"). The user's standing instructions are not
 * a floor here. `applyStandingInstructionEffects` runs after this sequence, on its output
 * (ADR-0113).
 */
export { matchesExposedCredentialClaim, matchesExposedSecret } from "./override";

export {
  applyStandingConsumerEffects,
  applyStandingInstructionEffects,
  standingInstructionEvidence,
  type StandingBriefingPriority,
  type StandingConsumerEffects,
  type StandingEffectAudit,
  type StandingEffectResult,
  type StandingEffectVerdict,
  type StandingFloorAudit,
  type StandingFloorOutcome,
  type StandingFloorResult,
  type StandingInstructionMatch,
  type StandingInstructionMatchVia,
} from "./standing";

/** Everything the floor sequence reads about one email. Assembled by `classifyEmail`. */
export interface FloorContext {
  /** Lowercased subject + body + snippet, shared with the override floor's veto. */
  signalText: string;
}

type FloorApply<R extends FloorResult> = (
  classification: TriageClassification,
  ctx: FloorContext,
) => R;

/** The `model` tag when the floor fires, else `""`. */
type FloorModelIdTag<R extends FloorResult> = (audit: R) => string;

/** Register one floor. Its result is its audit, so the audit cannot disagree with the verdict. */
function floor<N extends string, R extends FloorResult>(
  name: N,
  apply: FloorApply<R>,
  modelIdTag: FloorModelIdTag<R>,
) {
  return {
    name,
    run: (input: TriageClassification, ctx: FloorContext) => {
      const audit = apply(input, ctx);

      return {
        classification: applyFloorVerdict(input, audit.verdict),
        audit,
        modelIdTag: modelIdTag(audit),
      };
    },
  } as const;
}

/**
 * Order is the policy. The override floor runs alone, so a leaked secret escapes every
 * demotion. The output is the stored model verdict. The instruction floor applies the user's
 * effects to it after this sequence, so a consumer can derive the same result later.
 * A new floor also needs an entry in `FLOOR_TRACE_PROJECTIONS` and a step in
 * `applyFloors`; the compiler asks for both.
 */
const FLOOR_SEQUENCE = [
  floor(
    "override",
    (classification, ctx) => applyOverrideFloor(classification, ctx.signalText),
    (audit) => (audit.verdict.kind === "escalate" ? "+floor" : ""),
  ),
] as const;

/** Per-floor audits, keyed by floor name and derived from the sequence. */
export type FloorAudits = {
  [S in (typeof FLOOR_SEQUENCE)[number] as S["name"]]: ReturnType<S["run"]>["audit"];
};

export interface FloorOutcome {
  classification: TriageClassification;
  /** Nested, so a floor named `classification` cannot overwrite a sibling field. */
  audits: FloorAudits;
  modelIdTags: string[];
}

export function applyFloors(classification: TriageClassification, ctx: FloorContext): FloorOutcome {
  // Positional, so FLOOR_SEQUENCE alone sets the order. A new floor leaves `audits`
  // without its FloorAudits key, so the compiler asks for its step here.
  const [first] = FLOOR_SEQUENCE;
  const firstStep = first.run(classification, ctx);

  return {
    classification: firstStep.classification,
    audits: {
      [first.name]: firstStep.audit,
    },
    modelIdTags: firstStep.modelIdTag ? [firstStep.modelIdTag] : [],
  };
}
