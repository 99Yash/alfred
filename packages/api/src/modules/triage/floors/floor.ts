import type { TriageClassification } from "../classify";
import { truncateRationale } from "../rationale";

/**
 * The demoting floors, as the key each stamps ahead of its note. Closed rather
 * than `${string}_floor` because this value PERSISTS in `todoDecision.note` and
 * the over-tag audits (#210/#354) group on its prefix: a typo'd or improvised
 * key would compile, ship, and split one floor's rows across two prefixes with
 * nothing to notice it. A fourth demoting floor adds an arm here.
 */
type FloorDemotionKey = "sender_kind_floor" | "meeting_floor";

/**
 * What a floor DECIDES. Floors return a verdict rather than a classification so
 * that the conventions below are the only way to express a change:
 *
 *  - `demote` is DEMOTE, NEVER BURY (#210 asymmetry) — three parts that move
 *    together. A floor that demoted without clearing the todo would leave the
 *    rail asking for action on a thread Alfred just said needs none; one that
 *    cleared it without the `no_obligation` note would make the rail's decision
 *    untraceable; one that skipped the rationale clause would make the demotion
 *    invisible in the UI. A shared helper only ASKED for all three — the naive
 *    `{ ...classification, category: "fyi" }` a fourth floor would write
 *    typechecks and gets all three wrong, which is what both existing floors did
 *    before the registry. A verdict cannot express that mistake.
 *  - `escalate` raises the category with a confidence FLOOR, never an overwrite:
 *    a model already more confident than the floor keeps its number.
 *
 * Only {@link applyFloorVerdict} turns one into a classification, and only the
 * fold calls it — so the convention is enforced at the one place it is applied
 * rather than repeated at each floor that remembers to.
 */
export type FloorVerdict =
  | { kind: "keep" }
  | {
      kind: "demote";
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
    }
  | {
      kind: "escalate";
      to: TriageClassification["category"];
      /** Minimum confidence for the forced category; the model's own wins if higher. */
      confidenceFloor: number;
      /** The rationale clause, floor name included. */
      reason: string;
    };

/**
 * What every floor returns: its verdict plus its own audit facts. The fold in
 * `./index.ts` applies the verdict and files the WHOLE result under the floor's
 * name as that floor's audit, so "did this floor fire" is read off `verdict.kind`
 * by every consumer instead of being a boolean each floor reports about itself.
 */
export interface FloorResult {
  verdict: FloorVerdict;
}

/**
 * Apply one floor's verdict. The only writer of the demotion convention, and the
 * only reason `demote` needs no `category` argument: every demotion lands on
 * `fyi`. PURE.
 */
export function applyFloorVerdict(
  classification: TriageClassification,
  verdict: FloorVerdict,
): TriageClassification {
  switch (verdict.kind) {
    case "keep":
      return classification;
    case "escalate":
      return {
        ...classification,
        category: verdict.to,
        confidence: Math.max(classification.confidence, verdict.confidenceFloor),
        rationale: truncateRationale(`${classification.rationale} ${verdict.reason}`),
      };
    case "demote":
      return {
        ...classification,
        category: "fyi",
        todoSuggestion: null,
        todoDecision: { outcome: "no_obligation", note: `${verdict.key}: ${verdict.note}` },
        rationale: truncateRationale(
          `${classification.rationale} ${verdict.reason} — demoted ${classification.category} → fyi (demote, never bury).`,
        ),
      };
  }
}
