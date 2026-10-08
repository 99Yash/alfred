import type { TriageCategory } from "@alfred/contracts";
import type { TriageClassification } from "../classify";
import type { FloorResult } from "./floor";

/**
 * What the spam floor did (rule 20, #1098). Null means inert.
 *  - `demoted_reply_lane`: a reply lane under a spam verdict goes to `fyi`.
 *  - `held_demand_lane`: `urgent`/`action_needed` stays; a misfiled real ask costs more.
 * `held_demand_lane` does not say the model chose the lane. `floorForced = true`
 * means the override floor did. Before #1188 a second-pass throw could also
 * escalate, and traces never expire, so a history audit also needs:
 *
 *   decided_at < '2026-09-21T01:48:37Z'
 *     AND secondPassFailure IS NOT NULL
 *     AND conflict = 'under_classification'
 *     AND firstPassCategory IN ('fyi','done','newsletter','marketing')
 *
 * That is the merge time, not the deploy time, so widen it a little.
 * Trace key is `spamFloorOutcome`, not `spamDemotionReason`, which reads NULL silently.
 */
export type SpamFloorOutcome = "demoted_reply_lane" | "held_demand_lane";

/**
 * Lane policy, exhaustive over {@link TriageCategory}. A reply lane claims the
 * sender is owed something, which a spam verdict denies. A demand lane can be an
 * obligation the user already owned. Only the eval rows check which lane goes where.
 */
const SPAM_FLOOR_LANE_OUTCOMES = {
  awaiting_reply: "demoted_reply_lane",
  follow_up: "demoted_reply_lane",
  urgent: "held_demand_lane",
  action_needed: "held_demand_lane",
  meeting: null,
  payment: null,
  done: null,
  newsletter: null,
  marketing: null,
  fyi: null,
} satisfies Record<TriageCategory, SpamFloorOutcome | null>;

export function applySpamDemotionFloor(
  classification: TriageClassification,
  isSpam: boolean,
): FloorResult & { outcome: SpamFloorOutcome | null } {
  const outcome = isSpam ? SPAM_FLOOR_LANE_OUTCOMES[classification.category] : null;

  switch (outcome) {
    case null:
      return { verdict: { kind: "keep" }, outcome: null };
    case "held_demand_lane":
      return { verdict: { kind: "keep" }, outcome };
    case "demoted_reply_lane":
      return {
        verdict: {
          kind: "demote",
          key: "spam_floor",
          note: "Gmail filed this message as spam",
          reason:
            "Spam floor: Gmail filed this message as spam, so it cannot hold a reply-shaped category",
        },
        outcome,
      };
  }
}
