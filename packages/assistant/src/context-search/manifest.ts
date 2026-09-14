import {
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

/** One source the boundary did not consult, and why. */
export interface ContextSourceExclusion {
  readonly sourceId: string;
  /** Short, source-agnostic phrase naming the missing declaration. */
  readonly reason: string;
}

/** The split of registered sources into consulted and excluded. */
export interface ContextSourceSelection {
  readonly candidates: readonly ContextSource[];
  readonly excluded: readonly ContextSourceExclusion[];
}

/**
 * Split the registered sources into the ones this request can usefully ask and
 * the ones it cannot.
 *
 * Registration guarantees every source declares read semantics and an
 * authority above `unknown`, so the two exclusions here are the only ones left:
 *
 * - **Declared unavailable.** The source says it cannot be read right now (a
 *   disconnected integration, an MCP connection awaiting reauthorization).
 *   Silence is not this answer: an undeclared `availability` is still consulted.
 * - **No capability this request can use.** A source that only does exact
 *   lookups is not asked a free-text question with no object references
 *   attached; asking it would cost a read and return nothing.
 */
export function selectContextSources(
  sources: readonly ContextSource[],
  request: ContextSearchRequest,
): ContextSourceSelection {
  const candidates: ContextSource[] = [];
  const excluded: ContextSourceExclusion[] = [];

  for (const source of sources) {
    const reason = exclusionReason(source.manifest, request);

    if (reason === undefined) candidates.push(source);
    else excluded.push({ sourceId: source.id, reason });
  }

  return { candidates, excluded };
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

/** The manifest of every registered source, for a catalog view or a trace. */
export function listSourceManifests(sources: readonly ContextSource[]): readonly SourceManifest[] {
  return sources.map((source) => source.manifest);
}

/** Why this request cannot usefully ask this source, or `undefined` if it can. */
function exclusionReason(
  manifest: RetrievalSourceManifest,
  request: ContextSearchRequest,
): string | undefined {
  if (manifest.availability === "unavailable") return "source declares it is unavailable";

  if (answersFreeText(manifest)) return undefined;

  const wantsObjects = (request.objects?.length ?? 0) > 0;

  if (wantsObjects && sourceManifestSupportsRead(manifest, "exact_lookup")) return undefined;

  return "source declares no read capability that answers this request";
}

/**
 * Whether the source can be asked the request's free-text `query`.
 *
 * `query` is required on every request, so a source that searches text is
 * always a candidate. `enumerate` and `expand` do not qualify: listing recent
 * records ignores the question, and expansion needs a handle from a card that
 * does not exist yet (#428).
 */
function answersFreeText(manifest: RetrievalSourceManifest): boolean {
  return (
    sourceManifestSupportsRead(manifest, "semantic_search") ||
    sourceManifestSupportsRead(manifest, "keyword_search")
  );
}
