/** Test-only door to the pure ranker (#427) and source fixtures (#466). Not for production code. */

import type { ContextSearchRequest } from "@alfred/contracts";
import {
  defineContextSource,
  type ContextSource,
  type ContextSourceExpander,
  type ContextSourceReads,
  type ContextSourceResult,
} from "./registry";
import type { RetrievalSourceManifest } from "@alfred/contracts";

/**
 * Minimal valid manifest for a test source. `mediaKinds` is only `["text"]` so
 * the media-kind check stays meaningful. Tests about the manifest write their own.
 */
export function searchableTestSourceManifest(): Omit<RetrievalSourceManifest, "id" | "read"> {
  return {
    kind: "native",
    authority: { level: "medium" },
    mediaKinds: ["text"],
  };
}

/** A test source with its id stated once. */
export function defineTestContextSource(
  id: string,
  handler: (request: ContextSearchRequest) => Promise<ContextSourceResult>,
): ContextSource {
  return defineContextSource({
    id,
    manifest: searchableTestSourceManifest(),
    reads: testSourceReads(handler),
  });
}

/** The smallest source that can route a handle: `expand` plus its kinds (#1077). */
export function defineTestExpansionSource(
  id: string,
  expansionKinds: readonly string[],
  expand: ContextSourceExpander,
): ContextSource {
  return defineContextSource({
    id,
    manifest: { ...searchableTestSourceManifest(), expansionKinds: [...expansionKinds] },
    reads: { expand },
  });
}

/** One handler for both search capabilities, so `read` matches the reader keys. */
export function testSourceReads(
  handler: (request: ContextSearchRequest) => Promise<ContextSourceResult>,
): ContextSourceReads {
  return { semantic_search: handler, exact_lookup: handler };
}

export { EVIDENCE_RANK_FEATURES, entitySignificanceKey, rankEvidenceCards } from "./rank";

export { defineContextSource } from "./registry";

export type { ContextSourceExpander } from "./registry";

export type {
  EvidenceRankContext,
  EvidenceRankFeature,
  EvidenceRanking,
  RankedEvidence,
} from "./rank";
