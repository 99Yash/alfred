import {
  declaresReadSemantics,
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
 *
 * The reason exclusion is reported rather than hidden: "this source was not
 * asked" and "this source found nothing" are different facts, and ADR-0101's
 * honesty rule applies to the sources as much as to the evidence. A skipped
 * source becomes a `skipped` report, which `packEvidenceCards` renders, so a
 * misdeclared manifest shows up as a visible line rather than as a source that
 * quietly stopped contributing.
 *
 * What this file is NOT: a router. It never reads `discovery.topics`, never
 * matches the query text against a source, and never orders the candidates.
 * Choosing sources by guessing at query intent is the hard-coded switch this
 * whole contract replaces; the boundary asks every source that CAN answer and
 * lets the ranker sort the answers.
 */

/**
 * Why the boundary did not consult a source for one request.
 *
 * A closed set, not prose: registration guarantees every source declares read
 * semantics and an authority above `unknown`, so only two exclusions remain.
 * A third member is a deliberate schema-plus-code change, never a new string
 * at one call site.
 */
export const SOURCE_EXCLUSION_REASONS = ["unavailable", "no-answering-read"] as const;

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

/** Why this request cannot usefully ask this source, or `undefined` if it can. */
function exclusionReason(
  manifest: RetrievalSourceManifest,
  request: ContextSearchRequest,
): SourceExclusionReason | undefined {
  if (manifest.availability === "unavailable") return "unavailable";

  if (answersFreeText(manifest)) return undefined;

  const wantsObjects = (request.objects?.length ?? 0) > 0;

  if (wantsObjects && sourceManifestSupportsRead(manifest, "exact_lookup")) return undefined;

  return "no-answering-read";
}

/**
 * Whether the source can be asked the request's free-text `query`.
 *
 * `query` is required on every request, so a source that searches text is
 * always a candidate. `enumerate` and `expand` do not qualify: listing recent
 * records ignores the question, and expansion needs a handle from a card that
 * does not exist yet (#428). They remain valid declarations for that future
 * slice; in this slice a source declaring only them is excluded as
 * unanswerable, not consulted.
 */
function answersFreeText(manifest: RetrievalSourceManifest): boolean {
  return (
    sourceManifestSupportsRead(manifest, "semantic_search") ||
    sourceManifestSupportsRead(manifest, "keyword_search")
  );
}
