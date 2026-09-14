/**
 * Test-support door for the deterministic evidence ranker (#427).
 *
 * The production interface (`@alfred/assistant/context-search`) exposes only
 * `searchContext` and its result shape. The pure ranker lives here so unit
 * tests and the retrieval eval (#430) can drive it directly with an injected
 * entity map, without widening the production door. Nothing under
 * `src/` imports this file except tests and eval harnesses.
 */

export { EVIDENCE_RANK_FEATURES, entitySignificanceKey, rankEvidenceCards } from "./rank";

export type {
  EvidenceRankContext,
  EvidenceRankFeature,
  EvidenceRanking,
  RankedEvidence,
} from "./rank";
