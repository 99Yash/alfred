import type { TriageClassification } from "../classify";
import type { FloorResult } from "./floor";

/**
 * Gmail-spam demotion floor (rule 20's deterministic half). Gmail filed the
 * message as spam — its own verdict that the mail is unsolicited — so the
 * thread cannot hold a demanding category no matter which phrase the cheap
 * model fixated on:
 *
 *   - `awaiting_reply` off "Would love your thoughts!" in a spam-filed promo;
 *   - `urgent`/`action_needed` off scary words in a phish ("your API key
 *     leaked, click here to secure it").
 *
 * The second case is why the floor runs AFTER the override floor and still
 * demotes: an exposed-secret-shaped body inside Gmail spam is likelier phish
 * than a genuine scanning alert (genuine alerts do not arrive via spam), and
 * escalating phish to `urgent` is the worse miss. DEMOTE, NEVER BURY (#210
 * asymmetry) — demoted to `fyi` (still visible), with the stray todo cleared.
 *
 * Only the four demand lanes are gated. `meeting`/`payment`/`done`/
 * `newsletter`/`marketing`/`fyi` pass through untouched: the floor removes a
 * false demand, it never re-judges a passive tag. PURE.
 */
export type SpamDemotionReason = "gmail_spam";

export function applySpamDemotionFloor(
  classification: TriageClassification,
  isSpam: boolean,
): FloorResult & { reason: SpamDemotionReason | null } {
  if (!isSpam) {
    return { verdict: { kind: "keep" }, reason: null };
  }

  if (
    classification.category !== "urgent" &&
    classification.category !== "action_needed" &&
    classification.category !== "awaiting_reply" &&
    classification.category !== "follow_up"
  ) {
    return { verdict: { kind: "keep" }, reason: null };
  }

  return {
    verdict: {
      kind: "demote",
      key: "spam_floor",
      note: "Gmail filed this message as spam",
      reason:
        "Spam floor: Gmail filed this message as spam, so it cannot hold a demanding category",
    },
    reason: "gmail_spam",
  };
}
