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
import {
  defineContextSource,
  type ContextSource,
  type ContextSourceExpander,
  type ContextSourceReads,
  type ContextSourceResult,
} from "./registry";
import type { RetrievalSourceManifest } from "@alfred/contracts";

/**
 * The manifest fragment of an ordinary searchable test source (#466).
 *
 * Registration requires a manifest, and selection consults only a source that
 * declared read semantics, an authority, and at least one media kind (#429). A
 * test about something else — card validation, ranking, the tool adapter —
 * should not have to restate that declaration nine times, and a copied literal
 * would drift. The stable id is stated once per test (see
 * {@link defineTestContextSource}); the registry mints it into the manifest. A
 * test that is ABOUT the manifest writes its own literal instead, so the
 * degraded cases stay visible in the test that asserts them.
 *
 * `mediaKinds` is `["text"]` because the boundary now holds each card to its
 * source's declaration: a fixture that declared every modality would make the
 * check vacuous for every test that borrows this manifest. A test that returns
 * a media card declares the kind it returns.
 */
export function searchableTestSourceManifest(): Omit<RetrievalSourceManifest, "id" | "read"> {
  return {
    kind: "native",
    authority: { level: "medium" },
    mediaKinds: ["text"],
  };
}

/**
 * A test source whose id is stated once: the registry mints it into the
 * manifest and derives `read` from the readers, so the test never writes the
 * same id beside the manifest and on it.
 */
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

/**
 * A test source that only expands (#1077): it declares `expand` plus the handle
 * kinds it dereferences, and nothing else.
 *
 * Registration binds the capability and the kind list in both directions, so
 * this is the shortest source that can legally route a handle. A test ABOUT
 * that binding writes its own literal instead, so the rejected shapes stay
 * visible where they are asserted.
 */
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

export { defineContextSource } from "./registry";

export type { ContextSourceExpander } from "./registry";

export type {
  EvidenceRankContext,
  EvidenceRankFeature,
  EvidenceRanking,
  RankedEvidence,
} from "./rank";
