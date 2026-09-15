import {
  declaresReadSemantics,
  sourceManifestExpansionKinds,
  sourceManifestSupportsRead,
  type ContextSearchRequest,
  type RetrievalSourceManifest,
  type SourceManifest,
} from "@alfred/contracts";
import { sourcePriorityFromManifest } from "./rank";
import type { ContextSource } from "./registry";

/**
 * The manifest reader (#466; epic #422; ADR-0101).
 *
 * `registry.ts` stores what each source IS; this file is the only place that
 * decides what the boundary DOES about a source's declaration. It answers two
 * questions per read, and nothing here ever names a source:
 *
 * 1. **Which sources are candidates for this request?**
 *    {@link selectContextSources} reads declared availability and declared read
 *    capability against what the request actually asks for. A source that
 *    cannot be read, has not said how it can be read, or reads in a way this
 *    request has no use for is excluded WITH A REASON rather than consulted and
 *    silently unhelpful.
 * 2. **How much does each candidate's declaration weigh?**
 *    {@link contextSourcePriorities} folds each candidate's manifest into the
 *    per-source priority the deterministic ranker (#427) already had a seam for.
 * 3. **Which source can dereference a given handle?**
 *    {@link expansionRoutes} folds the declared expansion handle kinds into one
 *    kind-to-source table for the expansion phase (#1077). It reads the
 *    declared KIND and never the handle's own `sourceId`, so a card cannot
 *    choose who reads it.
 *
 * The reason exclusion is reported rather than hidden: "this source was not
 * asked" and "this source found nothing" are different facts, and ADR-0101's
 * honesty rule applies to the sources as much as to the evidence. A skipped
 * source becomes a `skipped` report, which `packEvidenceCards` renders, so a
 * misdeclared manifest shows up as a visible line rather than as a source that
 * quietly stopped contributing.
 *
 * What this file is NOT: a query-intent router. It never reads
 * `discovery.topics`, never matches the query text against a source, and never
 * orders the candidates. Choosing sources by guessing at query intent is the
 * hard-coded switch this whole contract replaces; the boundary asks every
 * source that CAN answer and lets the ranker sort the answers.
 *
 * It DOES route expansions by declared handle kind ({@link expansionRoutes}):
 * that is kind routing from a manifest declaration, not query-intent routing,
 * and it never names a source.
 */

/**
 * Why the boundary did not consult a source in the FIRST phase of one request.
 *
 * A closed set, not prose: registration guarantees every source declares read
 * semantics and an authority above `unknown`, so only three exclusions remain.
 * A fourth member is a deliberate schema-plus-code change, never a new string
 * at one call site.
 *
 * `expansion-only` is not a weaker `no-answering-read` — it is a different
 * fact, and telling them apart is the point (#1077). A source that cannot
 * answer this question will not be asked at all. A source that only expands
 * answers a DIFFERENT question, and the read may still consult it in the
 * second phase once a surviving card hands it a handle; when it does, the real
 * outcome replaces this skip in place.
 */
export const SOURCE_EXCLUSION_REASONS = [
  "unavailable",
  "no-answering-read",
  "expansion-only",
] as const;

export type SourceExclusionReason = (typeof SOURCE_EXCLUSION_REASONS)[number];

/**
 * Whether the source may be treated as a trusted retrieval source.
 *
 * Two declarations are required, and neither can be inferred:
 *
 * 1. **Read semantics.** Without them the boundary cannot say what asking this
 *    source a question even means.
 * 2. **Authority above `unknown`.** A source's own relevance `score` is the
 *    ranker's heaviest feature, and an undescribed source sets that number
 *    itself. Requiring a declared provenance is what stops an unknown MCP
 *    server from ranking itself first by returning `score: 1` on every card.
 *
 * The rule is uniform across `kind`: a first-party source that describes itself
 * as little as a stranger is trusted as little. Trust follows the declaration,
 * never the author.
 *
 * This is a decision about a manifest, not a fact about one, so it lives here
 * beside the selection policy — not in `@alfred/contracts`, where every
 * consumer would inherit one reader's opinion. It stays until a second reader
 * across a boundary (a web catalog) must agree on it.
 */
export function isTrustedRetrievalSource(manifest: SourceManifest): boolean {
  if (!declaresReadSemantics(manifest)) return false;

  const level = manifest.authority?.level;

  return level !== undefined && level !== "unknown";
}

/**
 * The sources this request cannot usefully ask, keyed by source id.
 *
 * A map, not a split: the only caller (`searchContext`) must keep reports in
 * REGISTRATION order, and a split forced it to rebuild a lookup from the
 * excluded half and re-loop the original array to restore the order the split
 * destroyed. An absent key means the source is a candidate.
 */
export function selectContextSources(
  sources: readonly ContextSource[],
  request: ContextSearchRequest,
): ReadonlyMap<string, SourceExclusionReason> {
  const excluded = new Map<string, SourceExclusionReason>();

  for (const source of sources) {
    const reason = exclusionReason(source.manifest, request);

    if (reason !== undefined) excluded.set(source.id, reason);
  }

  return excluded;
}

/**
 * Per-source ranking priority, keyed by `ContextSource.id` (ADR-0101
 * sub-decision 13).
 *
 * Every registered source folds to a number: a declared reading scores its
 * declared value and an undeclared axis scores its `unknown` row, divided by
 * the fixed total weight. Silence and declared `unknown` therefore agree and
 * omission buys nothing.
 */
export function contextSourcePriorities(
  sources: readonly ContextSource[],
): ReadonlyMap<string, number> {
  const priorities = new Map<string, number>();

  for (const source of sources) {
    priorities.set(source.id, sourcePriorityFromManifest(source.manifest));
  }

  return priorities;
}

/**
 * The expansion routing table: handle kind to the source that dereferences it
 * (#1077).
 *
 * Built from declared `expansionKinds` alone, so a handle reaches a source by
 * what that source says it can read and never by the `sourceId` the handle
 * carries. A card that named its own expander would be a source choosing its
 * own reader, which is the name switch this module exists to remove; the
 * handle's `sourceId` stays a debugging fact.
 *
 * Two sources declaring one kind is a composition-root ambiguity, not a read
 * failure: the first REGISTERED source wins, which keeps the route stable
 * across reads and matches the registration-order rule the reports already
 * follow. An `unavailable` source routes nothing — a boot-time admission that
 * it cannot be read applies to both phases. The check reads
 * `manifest.availability` directly rather than the first-phase exclusion map,
 * so a future exclusion reason cannot silently become routable by forgetting
 * a second edit here.
 */
export function expansionRoutes(
  sources: readonly ContextSource[],
): ReadonlyMap<string, ContextSource> {
  const routes = new Map<string, ContextSource>();

  for (const source of sources) {
    if (source.manifest.availability === "unavailable") continue;

    if (!sourceManifestSupportsRead(source.manifest, "expand")) continue;

    for (const kind of sourceManifestExpansionKinds(source.manifest)) {
      if (!routes.has(kind)) routes.set(kind, source);
    }
  }

  return routes;
}

/** Why this request cannot usefully ask this source, or `undefined` if it can. */
function exclusionReason(
  manifest: RetrievalSourceManifest,
  request: ContextSearchRequest,
): SourceExclusionReason | undefined {
  if (manifest.availability === "unavailable") return "unavailable";

  if (answersFreeText(manifest)) return undefined;

  const wantsObjects = (request.objects?.length ?? 0) > 0;

  if (wantsObjects && sourceManifestSupportsRead(manifest, "exact_lookup")) return undefined;

  // The source may still be reached by a handle in the second phase, so the
  // skip states WHY it was not asked the question rather than claiming it could
  // not have helped. Only a source that ONLY expands takes `expansion-only`:
  // an `exact_lookup` source that also expands is `no-answering-read` on a
  // request with no `objects`, because the packer must not tell the model it
  // "only re-reads records other sources found" about a source that also does
  // exact lookups.
  if (isExpansionOnlySource(manifest)) return "expansion-only";

  return "no-answering-read";
}

/**
 * Whether the source only expands, and so answers a different question rather
 * than this request's question (#1077).
 *
 * `manifest.read` is the required retrieval subtype, so the sole-capability
 * check is total: a source whose only declared read is `expand` is the one the
 * `expansion-only` skip reason — and the packer's "only re-reads records other
 * sources found" — describes truthfully.
 */
function isExpansionOnlySource(manifest: RetrievalSourceManifest): boolean {
  return manifest.read.length === 1 && sourceManifestSupportsRead(manifest, "expand");
}

/**
 * Whether the source can be asked the request's free-text `query`.
 *
 * `query` is required on every request, so a source that searches text is
 * always a candidate. `enumerate` and `expand` do not qualify: listing recent
 * records ignores the question, and expansion needs a handle that no card has
 * produced yet at selection time. `enumerate` remains declared vocabulary with
 * no phase behind it; `expand` has its own phase and its own
 * `expansion-only` skip reason (#1077).
 */
function answersFreeText(manifest: RetrievalSourceManifest): boolean {
  return (
    sourceManifestSupportsRead(manifest, "semantic_search") ||
    sourceManifestSupportsRead(manifest, "keyword_search")
  );
}
