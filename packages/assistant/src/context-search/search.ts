import {
  contextSearchRequestSchema,
  evidenceCardSchema,
  toMessage,
  type ContextSearchRequest,
  type EvidenceCard,
} from "@alfred/contracts";
import { listContextSources } from "./registry";

/**
 * The read-side answer shapes (#422; ADR-0101).
 *
 * These live here — not in a `types.ts` grab-bag — because `searchContext`
 * below is the only code that mints them: every `ContextSourceReport` status
 * (`ok` / `empty` / `error`) and every `ContextSearchResult` truncation to
 * `request.limit` happens in this file. The source-side element is the
 * canonical `EvidenceCard` in `@alfred/contracts` (#423), imported rather than
 * restated here; `registry.ts` owns the `ContextSource` contract that returns
 * it.
 *
 * The card contract and the packing rules live in their own files: the shape in
 * `@alfred/contracts` (browser/server agreement, manifest interoperability) and
 * `pack.ts` here (model-facing rendering). This file only collects and bounds.
 */

/**
 * Per-source outcome for one search. `empty` is distinct from `error` on
 * purpose: "this source found nothing" and "this source could not answer" are
 * different facts, and the honest-missing note (#423) depends on telling them
 * apart.
 */
export type ContextSourceStatus = "ok" | "empty" | "error";

export interface ContextSourceReport {
  readonly sourceId: string;
  readonly status: ContextSourceStatus;
  /**
   * How many cards the source returned. This is the source's own count, before
   * the boundary truncates the combined list to `request.limit`; it does not sum
   * to `ContextSearchResult.evidence.length` when the limit binds.
   */
  readonly evidenceCount: number;
  /** Present only for `error`; the safe message from the failed source. */
  readonly reason?: string | undefined;
}

/** The typed result of one read. `evidence` is empty until adapters land. */
export interface ContextSearchResult {
  /** The parsed request this result answers. */
  readonly request: ContextSearchRequest;
  /** Evidence, bounded by `request.limit`. */
  readonly evidence: readonly EvidenceCard[];
  /** One report per registered source consulted. */
  readonly sources: readonly ContextSourceReport[];
}

/**
 * Read-only evidence search across every registered context search source.
 *
 * This is the boundary's one verb. With no source registered — the state at
 * this slice — it returns an empty, typed result rather than throwing, so a
 * caller degrades honestly before any adapter exists. A source that throws
 * becomes one `error` report; it never fails the whole search, and absence
 * never closes a loop.
 *
 * Ranking is deliberately absent here. Cards come back in source-registration
 * order and the combined list is truncated to the request `limit`, so an earlier
 * source can fill the budget and a later source's cards can be dropped even
 * though their report still counts them. The deterministic ranker (#427) and a
 * per-source budget replace that truncation without changing the shape.
 */
export async function searchContext(request: unknown): Promise<ContextSearchResult> {
  const parsed = contextSearchRequestSchema.parse(request);
  const sources = listContextSources();

  if (sources.length === 0) {
    return { request: parsed, evidence: [], sources: [] };
  }

  const reports: ContextSourceReport[] = [];
  const collected: EvidenceCard[] = [];

  for (const source of sources) {
    try {
      const result = await source.search(parsed);
      // A card is a contract, not a type-only promise: re-validate every card at
      // the boundary so a source cannot smuggle in an unbounded snippet, a
      // non-canonical entity value, or an empty card. A bad card fails its
      // source, which is reported like any other source error.
      const evidence = evidenceCardSchema.array().parse(result.evidence);

      reports.push({
        sourceId: source.id,
        status: evidence.length > 0 ? "ok" : "empty",
        evidenceCount: evidence.length,
      });
      collected.push(...evidence);
    } catch (error) {
      reports.push({
        sourceId: source.id,
        status: "error",
        evidenceCount: 0,
        reason: toMessage(error),
      });
    }
  }

  return {
    request: parsed,
    evidence: collected.slice(0, parsed.limit),
    sources: reports,
  };
}
