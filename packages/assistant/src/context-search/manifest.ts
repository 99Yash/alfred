import {
  declaresReadSemantics,
  sourceManifestExpansionKinds,
  sourceManifestSupportsRead,
  type ContextSearchRequest,
  type RetrievalSourceManifest,
  type SourceCostBudget,
  type SourceCostClass,
  type SourceManifest,
} from "@alfred/contracts";
import { sourcePriorityFromManifest } from "./rank";
import { READER_DECLINED_REASONS, type ContextSource, type ReaderDeclinedReason } from "./registry";

/**
 * The manifest reader (#466, ADR-0101): the only code that acts on a source's
 * declaration. It never names a source.
 * - {@link selectContextSources}: which sources to skip, each with a reason.
 * - {@link contextSourcePriorities}: the ranker's per-source priority.
 * - {@link expansionRoutes}: handle kind to expanding source (#1077).
 * Not a query-intent router: it never reads the query text or `discovery.topics`.
 */

/**
 * Why selection skipped a source in the first phase. Readers decline with
 * {@link ReaderDeclinedReason}; neither side mints the other's reasons.
 * `expansion-only` differs from `no-answering-read`: the source may still be
 * consulted in the expansion phase (#1077).
 */
export const SELECTION_EXCLUSION_REASONS = [
  "unavailable",
  "no-answering-read",
  "expansion-only",
  "over-budget",
] as const;

export type SelectionExclusionReason = (typeof SELECTION_EXCLUSION_REASONS)[number];

/** Every reason a `skipped` report can carry. */
export type SourceExclusionReason = SelectionExclusionReason | ReaderDeclinedReason;

export const SOURCE_EXCLUSION_REASONS: readonly SourceExclusionReason[] = [
  ...SELECTION_EXCLUSION_REASONS,
  ...READER_DECLINED_REASONS,
];

/**
 * Spending ladder (#1078). A spending decision, so it lives here and not in
 * `@alfred/contracts`. An undeclared cost ranks at the top, so silence cannot
 * dodge a budget.
 */
const COST_RANK = {
  local: 0,
  metered: 1,
  remote: 2,
} as const satisfies Record<SourceCostBudget, number>;

const UNPRICED_COST_RANK: number = Math.max(...Object.values(COST_RANK));

function costRank(costClass: SourceCostClass): number {
  return costClass === "unknown" ? UNPRICED_COST_RANK : COST_RANK[costClass];
}

/** Shared by selection and expansion routing, so both price a source the same way (#1078). */
export function exceedsCostBudget(manifest: SourceManifest, budget: SourceCostBudget): boolean {
  return costRank(manifest.cost?.class ?? "unknown") > costRank(budget);
}

/**
 * Needs declared read semantics and an authority above `unknown`. Otherwise an
 * unknown MCP server could rank itself first with `score: 1` on every card.
 * The rule ignores `kind`: trust follows the declaration, not the author.
 */
export function isTrustedRetrievalSource(manifest: SourceManifest): boolean {
  if (!declaresReadSemantics(manifest)) return false;

  const level = manifest.authority?.level;

  return level !== undefined && level !== "unknown";
}

/** Sources this request cannot usefully ask, keyed by id. A map, so the caller keeps registration order. */
export function selectContextSources(
  sources: readonly ContextSource[],
  request: ContextSearchRequest,
): ReadonlyMap<string, SelectionExclusionReason> {
  const excluded = new Map<string, SelectionExclusionReason>();

  for (const source of sources) {
    const reason = exclusionReason(source.manifest, request);

    if (reason !== undefined) excluded.set(source.id, reason);
  }

  return excluded;
}

/** Ranking priority per source id (ADR-0101 sub-decision 13). */
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
 * Handle kind to expanding source (#1077), from declared `expansionKinds` only,
 * never the handle's `sourceId`. The first registered source wins a shared kind.
 * Unavailable and over-budget sources route nothing.
 */
export function expansionRoutes(
  sources: readonly ContextSource[],
  request: ContextSearchRequest,
): ReadonlyMap<string, ContextSource> {
  const routes = new Map<string, ContextSource>();

  for (const source of sources) {
    if (source.manifest.availability === "unavailable") continue;

    if (exceedsCostBudget(source.manifest, request.maxSourceCost)) continue;

    if (!sourceManifestSupportsRead(source.manifest, "expand")) continue;

    for (const kind of sourceManifestExpansionKinds(source.manifest)) {
      if (!routes.has(kind)) routes.set(kind, source);
    }
  }

  return routes;
}

function exclusionReason(
  manifest: RetrievalSourceManifest,
  request: ContextSearchRequest,
): SelectionExclusionReason | undefined {
  if (manifest.availability === "unavailable") return "unavailable";

  // Price first, so the model reads "not paid for", not "had nothing".
  if (exceedsCostBudget(manifest, request.maxSourceCost)) return "over-budget";

  if (answersFreeText(manifest)) return undefined;

  const wantsObjects = (request.objects?.length ?? 0) > 0;

  if (wantsObjects && sourceManifestSupportsRead(manifest, "exact_lookup")) return undefined;

  // Only a source whose sole read is `expand` gets `expansion-only`.
  if (isExpansionOnlySource(manifest)) return "expansion-only";

  return "no-answering-read";
}

function isExpansionOnlySource(manifest: RetrievalSourceManifest): boolean {
  return manifest.read.length === 1 && sourceManifestSupportsRead(manifest, "expand");
}

/** `enumerate` ignores the question, and `expand` needs a handle, so neither answers free text. */
function answersFreeText(manifest: RetrievalSourceManifest): boolean {
  return (
    sourceManifestSupportsRead(manifest, "semantic_search") ||
    sourceManifestSupportsRead(manifest, "keyword_search")
  );
}
