import type { TriageCategory } from "@alfred/contracts";
import type { TriageClassification } from "../classify";
import type { FloorResult } from "./floor";

/**
 * What the spam floor CONCLUDED, named for what the floor DID rather than for
 * who decided — the floor sees one category and one boolean, so it cannot
 * observe whether a model, an earlier floor, or a failure path produced the
 * category it reads. `null` means the floor was inert: either Gmail did not file
 * the mail as spam, or it did and the category is already passive.
 *
 * The two members are the two halves of rule 20 after #1098 softened it. Gmail's
 * spam verdict is a third party's, and it is fallible, so it buys an absolute on
 * the reply lanes and a strong PRIOR everywhere else:
 *
 *  - `demoted_reply_lane` — the absolute. `awaiting_reply`/`follow_up` under a
 *    spam verdict is the model reading promo copy ("Would love your thoughts!")
 *    as an owed reply. Demoted to `fyi`, stray todo cleared. DEMOTE, NEVER BURY
 *    (#210 asymmetry): still visible, just not on the reply rail.
 *  - `held_demand_lane` — the prior. `urgent`/`action_needed` under a spam
 *    verdict is left ALONE, because a misfiled genuine ask (a recruiter asking
 *    the user to finish an application the USER opened, a leaked credential of
 *    the user's that must be rotated) is the miss that costs more. Rule 20 still
 *    tells the model to answer passively unless the body names an obligation the
 *    user owns independently of trusting the sender.
 *
 * `held_demand_lane` does NOT say the model chose the lane. Exactly ONE
 * deterministic producer can write a demand lane no model voted on, and an
 * over-tag audit (#210/#354) separates it on the same flat trace row:
 * `floorForced = true` — the override floor force-escalated an exposed-secret
 * body to `urgent` at sequence position 1. Exact: the field keys on
 * `verdict.kind === "escalate"`, not on a match.
 *
 * Do NOT add a second join on `secondPassFailure`. A throw on the under-
 * classification second pass once escalated a passive first pass to
 * `action_needed`; that branch is gone, so a second-pass throw now resolves to
 * the model's own first pass in both conflict directions and attributes nothing
 * to the deterministic layer.
 *
 * A `held_demand_lane` row that does not match `floorForced` is the model's own
 * judgment.
 *
 * The trace key is `spamFloorOutcome`, NOT `spamDemotionReason`. TWO of the
 * three sibling floors — `senderKind` and `meeting` — project
 * `<floor>DemotedCategory`/`<floor>DemotionReason`; the `override` floor keeps
 * neither half and projects `floorMatched`/`floorForced`. This floor breaks the
 * `DemotionReason` half ON PURPOSE, because one of its two values means "no
 * demotion" and the conventional `IS NOT NULL` over-counts the floor. It keeps
 * the other half: `spamDemotedCategory` is projected under the usual name. The
 * price is a SILENT one: `trace->>'spamDemotionReason'` reads as SQL NULL
 * rather than failing, so a cross-floor audit written to the convention reports
 * ZERO spam-floor activity and no error. An audit of this floor must read
 * `spamFloorOutcome` and compare it to a member.
 *
 * Runs AFTER the override floor. That escalation now SURVIVES a spam verdict —
 * the deliberate price of keeping a rotation ask that Gmail misfiled. See the
 * residual risk in #1098.
 *
 * `meeting`/`payment`/`done`/`newsletter`/`marketing`/`fyi` pass through
 * untouched: the floor removes a false demand, it never re-judges a passive tag.
 * PURE.
 */
export type SpamFloorOutcome = "demoted_reply_lane" | "held_demand_lane";

/**
 * The floor's whole lane policy, one row per category and EXHAUSTIVE over
 * {@link TriageCategory}. One table rather than a gated lane set plus a
 * category comparison chain: those were two constructs spelling one policy with
 * nothing binding them, so moving a lane across the gate line — the change
 * #1098 just made, on five spam documents in ten days — was two edits, and half
 * of it compiled and shipped silently. It also made three illegal verdict/reason
 * pairs representable. Here the verdict is DERIVED from the outcome below, so
 * the pairing is total again, and a new `TriageCategory` is a type error rather
 * than a silent `null`.
 *
 * Measured, which is why the line falls where it does: over 315 Gmail documents
 * in ten days, five carried the `SPAM` label and exactly two reached a demand
 * lane — one `awaiting_reply` (a hackathon pitch whose "would love your
 * thoughts" copy is engagement bait, where Gmail was right) and one
 * `action_needed` (a recruiter asking the user to finish a job application the
 * USER had opened, where Gmail was wrong). A reply lane asserts the SENDER is
 * owed something, which is exactly the claim a spam verdict denies;
 * `urgent`/`action_needed` can assert an obligation the USER already owned
 * before the mail arrived, which a spam verdict says nothing about.
 *
 * Residual risk the compiler cannot hold: WHICH lane belongs in which row is
 * policy. The type keeps the table total; the eval rows in
 * `evals/triage-classify.eval.ts` are the only gate on the values.
 *
 * Module-local on purpose — no call site chooses these lanes.
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
