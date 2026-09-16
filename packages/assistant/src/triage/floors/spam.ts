import type { TriageClassification } from "../classify";
import type { FloorResult } from "./floor";

/**
 * The lanes the spam floor still enforces DETERMINISTICALLY. Reply-shaped only,
 * and measured: over 315 Gmail documents in ten days, five carried the `SPAM`
 * label and exactly two reached a demand lane — one `awaiting_reply` (a
 * hackathon pitch whose "would love your thoughts" copy is engagement bait,
 * where Gmail was right) and one `action_needed` (a recruiter asking the user to
 * finish a job application the USER had opened, where Gmail was wrong). The
 * split runs along the lane, so the floor does too.
 *
 * A reply lane asserts the SENDER is owed something, which is exactly the claim
 * a spam verdict denies; `urgent`/`action_needed` can assert an obligation the
 * USER already owned before the mail arrived, which a spam verdict says nothing
 * about. Module-local on purpose — no call site chooses these lanes.
 */
const SPAM_FLOOR_ENFORCED_LANES: ReadonlySet<TriageClassification["category"]> = new Set([
  "awaiting_reply",
  "follow_up",
]);

/**
 * What the spam floor CONCLUDED, not merely why it demoted. `null` means the
 * floor was inert — either Gmail did not file the mail as spam, or it did and
 * the model already chose a passive tag (rule 20 obeyed, nothing left to do).
 *
 * The two members are the two halves of rule 20 after #1098 softened it. Gmail's
 * spam verdict is a third party's, and it is fallible, so it buys an absolute on
 * the reply lanes and a strong PRIOR everywhere else:
 *
 *  - `demoted_reply_lane` — the absolute. `awaiting_reply`/`follow_up` under a
 *    spam verdict is the model reading promo copy ("Would love your thoughts!")
 *    as an owed reply. Demoted to `fyi`, stray todo cleared. DEMOTE, NEVER BURY
 *    (#210 asymmetry): still visible, just not on the reply rail.
 *  - `prior_only_demand_lane` — the prior. `urgent`/`action_needed` under a spam
 *    verdict is left ALONE, because a misfiled genuine ask (the recruiter row
 *    above, a leaked credential of the user's that must be rotated) is the miss
 *    that costs more. Rule 20 still tells the model to answer passively unless
 *    the body names an obligation the user owns independently of trusting the
 *    sender; the model, not this floor, decides whether it does.
 *
 * The distinction is the audit's: a spam-filed `urgent` in the trace is now
 * attributable to the model's own judgment rather than to a floor that never
 * ran, which is what an over-tag audit (#210/#354) needs to tell a softened spam
 * apart from a sender-kind demotion.
 *
 * Runs AFTER the override floor, which force-escalates any exposed-secret body
 * to `urgent`. That escalation now SURVIVES a spam verdict — the deliberate
 * price of keeping a rotation ask that Gmail misfiled. See the residual risk in
 * #1098.
 *
 * `meeting`/`payment`/`done`/`newsletter`/`marketing`/`fyi` pass through
 * untouched: the floor removes a false demand, it never re-judges a passive tag.
 * PURE.
 */
export type SpamFloorOutcome = "demoted_reply_lane" | "prior_only_demand_lane";

export function applySpamDemotionFloor(
  classification: TriageClassification,
  isSpam: boolean,
): FloorResult & { reason: SpamFloorOutcome | null } {
  if (!isSpam) {
    return { verdict: { kind: "keep" }, reason: null };
  }

  if (classification.category === "urgent" || classification.category === "action_needed") {
    return { verdict: { kind: "keep" }, reason: "prior_only_demand_lane" };
  }

  if (!SPAM_FLOOR_ENFORCED_LANES.has(classification.category)) {
    return { verdict: { kind: "keep" }, reason: null };
  }

  return {
    verdict: {
      kind: "demote",
      key: "spam_floor",
      note: "Gmail filed this message as spam",
      reason:
        "Spam floor: Gmail filed this message as spam, so it cannot hold a reply-shaped category",
    },
    reason: "demoted_reply_lane",
  };
}
