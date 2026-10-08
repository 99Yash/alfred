import type { TriageClassification } from "../classify";
import { truncateRationale } from "../rationale";

/** Persisted as the `todoDecision.note` prefix that audits group on, so keep the set closed. */
type FloorDemotionKey = "sender_kind_floor" | "meeting_floor" | "spam_floor";

/**
 * A floor returns a verdict, not a classification, so it cannot get the rules wrong.
 * `demote` (demote, never bury, #210) also clears the todo, notes why, and updates the rationale.
 * `escalate` sets a confidence minimum; a more confident model keeps its number.
 */
export type FloorVerdict =
  | { kind: "keep" }
  | {
      kind: "demote";
      key: FloorDemotionKey;
      note: string;
      /** Rationale clause, floor name included. Can be longer than `note`. */
      reason: string;
    }
  | {
      kind: "escalate";
      to: TriageClassification["category"];
      confidenceFloor: number;
      reason: string;
    };

/** A floor's verdict plus its audit facts. The whole result is the floor's audit. */
export interface FloorResult {
  verdict: FloorVerdict;
}

/** The only writer of the demotion rules. Every demotion lands on `fyi`. */
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
        documentAsk: null,
        todoSuggestion: null,
        todoDecision: { outcome: "no_obligation", note: `${verdict.key}: ${verdict.note}` },
        rationale: truncateRationale(
          `${classification.rationale} ${verdict.reason} — demoted ${classification.category} → fyi (demote, never bury).`,
        ),
      };
  }
}
