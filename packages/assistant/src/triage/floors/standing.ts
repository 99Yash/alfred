import type { TriageCategory } from "@alfred/contracts";
import type { TriageClassification } from "../classify";
import type { TriageStandingDirective } from "../observations";
import type { FloorResult } from "./floor";
import { matchesExposedSecret } from "./override";

/**
 * What the standing floor did (ADR-0110, amending ADR-0106's prior-only stance).
 * Null means inert.
 *  - `demoted_demand_lane`: a matched sender instruction demoted `urgent`/`action_needed` to `fyi`.
 *  - `held_secret_lane`: an exposed-secret signal fired, so the user's down-rank lost
 *    (the override outranks it, ADR-0106's bar kept) and the demand lane stayed.
 * `held_secret_lane` does not say the model chose the lane — `floorForced = true` means
 * the override floor did. The trace key is `standingFloorOutcome`, not a
 * `standingDemotionReason`, which would read NULL silently: this outcome can hang
 * off a keep verdict, so count demotions with `= 'demoted_demand_lane'`; `IS NOT NULL`
 * over-counts.
 */
export type StandingFloorOutcome = "demoted_demand_lane" | "held_secret_lane";

/**
 * Lane policy, exhaustive over {@link TriageCategory}. The instruction is about importance,
 * so only a surviving demand lane dies here — never a `meeting` the user accepted, a
 * `payment` due, or a category that is already passive.
 */
const STANDING_FLOOR_LANE_OUTCOMES = {
  awaiting_reply: null,
  follow_up: null,
  urgent: "demoted_demand_lane",
  action_needed: "demoted_demand_lane",
  meeting: null,
  payment: null,
  done: null,
  newsletter: null,
  marketing: null,
  fyi: null,
} satisfies Record<TriageCategory, StandingFloorOutcome | null>;

/**
 * The user's own words for THIS sender, enforced. `instruction` is the category-lane
 * read from `gatherObservations` (`demote_demand`), so a null here means
 * "no active instruction" AND "read failed" together — a failed read must never
 * over-suppress, and the trace's `standingInstructionCategoryReadFailed` still
 * tells the two apart.
 */
export function applyStandingDemotionFloor(
  classification: TriageClassification,
  context: {
    standingInstruction: TriageStandingDirective | null;
    /** Lowercased subject + body + snippet, shared with the override floor's veto. */
    signalText: string;
  },
): FloorResult & { outcome: StandingFloorOutcome | null } {
  const instruction = context.standingInstruction;

  // Unknown scope: no matched instruction this run. A `read_failed` read also
  // arrives as null — never over-suppress on unknown. Hand-built observation
  // fixtures (tests, evals) may leave the key off entirely, so also `undefined`.
  if (instruction == null) return { verdict: { kind: "keep" }, outcome: null };

  const laneOutcome = STANDING_FLOOR_LANE_OUTCOMES[classification.category];

  if (laneOutcome === null) return { verdict: { kind: "keep" }, outcome: null };

  // The protective security bar survives the user's down-rank (ADR-0106, kept in
  // ADR-0110): a leaked secret on a suppressed sender still lands on `urgent`.
  if (matchesExposedSecret(context.signalText)) {
    return { verdict: { kind: "keep" }, outcome: "held_secret_lane" };
  }

  return {
    verdict: {
      kind: "demote",
      key: "standing_floor",
      // The fact id joins the audit back to the instruction row.
      note: `User standing instruction for this sender (fact ${instruction.factId})`,
      reason:
        `Standing instruction floor: the user's own words for this sender (fact ${instruction.factId}) ` +
        "say to treat this mail as FYI, not a thing to do.",
    },
    outcome: laneOutcome,
  };
}
