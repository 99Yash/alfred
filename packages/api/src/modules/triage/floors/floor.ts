import type { TriageClassification } from "../classify";
import { truncateRationale } from "../rationale";

/**
 * What every floor returns: the (possibly changed) classification plus its own
 * audit facts. The fold in `./index.ts` strips `classification` off and files
 * the rest under the floor's name, so a floor's audit shape is whatever else it
 * declares here — nothing restates it.
 */
export interface FloorResult {
  classification: TriageClassification;
}

/**
 * The demoting floors, as the key each stamps ahead of its note. Closed rather
 * than `${string}_floor` because this value PERSISTS in `todoDecision.note` and
 * the over-tag audits (#210/#354) group on its prefix: a typo'd or improvised
 * key would compile, ship, and split one floor's rows across two prefixes with
 * nothing to notice it. A fourth demoting floor adds an arm here.
 */
export type FloorDemotionKey = "sender_kind_floor" | "meeting_floor";

/**
 * The one demotion convention every demoting floor applies: DEMOTE, NEVER BURY
 * (#210 asymmetry). The thread drops to `fyi` — still visible — the stray todo
 * the model minted from the same misread is cleared with a rubric-legible
 * decision, and the rationale gains one clause naming the floor that fired.
 *
 * Shared rather than copied because the three parts move together: a floor that
 * demoted without clearing the todo would leave the rail asking for action on a
 * thread Alfred just said needs none, and one that cleared the todo without the
 * `no_obligation` note would make the rail's decision untraceable. PURE.
 */
export function demoteToFyi(
  classification: TriageClassification,
  demotion: {
    /** Floor identity, stamped ahead of `note` on the cleared todo's decision. */
    key: FloorDemotionKey;
    /** Why this floor fired, in prose. */
    note: string;
    /**
     * The rationale's reason clause, floor name included. Not always `note` —
     * the sender-kind floor spells out its projection confidence here and keeps
     * the shorter `note` for the todo decision.
     */
    reason: string;
  },
): TriageClassification {
  return {
    ...classification,
    category: "fyi",
    todoSuggestion: null,
    todoDecision: { outcome: "no_obligation", note: `${demotion.key}: ${demotion.note}` },
    rationale: truncateRationale(
      `${classification.rationale} ${demotion.reason} — demoted ${classification.category} → fyi (demote, never bury).`,
    ),
  };
}
