/**
 * Test-support door for the deterministic evidence ranker (#427) and the source
 * capability manifest (#466).
 *
 * The production interface (`@alfred/assistant/context-search`) exposes only
 * `searchContext` and its result shape. The pure ranker lives here so unit
 * tests and the retrieval eval (#430) can drive it directly with an injected
 * entity map, without widening the production door. Nothing under
 * `src/` imports this file except tests and eval harnesses.
 */

import type { ContextSearchRequest } from "@alfred/contracts";
import type { ContextSourceReads, ContextSourceResult } from "./registry";
import type { RetrievalSourceManifest } from "@alfred/contracts";

/**
 * The manifest of an ordinary searchable test source (#466).
 *
 * Registration requires a manifest, and selection consults only a source that
 * declared read semantics and an authority. A test about something else — card
 * validation, ranking, the tool adapter — should not have to restate that
 * declaration nine times, and a copied literal would drift. A test that is
 * ABOUT the manifest writes its own literal instead, so the degraded cases stay
 * visible in the test that asserts them.
 */
export function searchableTestSourceManifest(id: string): RetrievalSourceManifest {
  return {
    id,
    kind: "native",
    read: ["semantic_search", "exact_lookup"],
    authority: { level: "medium" },
  };
}

/**
 * Readers for a test source that answers every declared capability the same
 * way. Registration requires `manifest.read` to equal the keys of `reads`, so
 * a test cannot hand-write one `search` body beside a two-capability manifest
 * without drifting; this builds both readers from the one handler.
 */
export function testSourceReads(
  handler: (request: ContextSearchRequest) => Promise<ContextSourceResult>,
): ContextSourceReads {
  return { semantic_search: handler, exact_lookup: handler };
}

export { EVIDENCE_RANK_FEATURES, entitySignificanceKey, rankEvidenceCards } from "./rank";

export type {
  EvidenceRankContext,
  EvidenceRankFeature,
  EvidenceRanking,
  RankedEvidence,
} from "./rank";
