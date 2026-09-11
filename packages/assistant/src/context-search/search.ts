import {
  contextSearchRequestSchema,
  toMessage,
  type ContextSearchRequest,
} from "@alfred/contracts";
import { listContextSources, type ContextEvidence } from "./registry";

/**
 * The read-side answer shapes (#422; ADR-0101).
 *
 * These live here — not in a `types.ts` grab-bag — because `searchContext`
 * below is the only code that mints them: every `ContextSourceReport` status
 * (`ok` / `empty` / `error`) and every `ContextSearchResult` truncation to
 * `request.limit` happens in this file. The source-side element
 * (`ContextEvidence`) lives in `registry.ts` with the `ContextSource` contract
 * that returns it; this file imports it rather than restating it.
 *
 * Module-internal placeholders, not contracts consumers may build on: #423
 * owns the canonical EvidenceCard and the packing rules, and may replace these
 * shapes outright.
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
  readonly evidence: readonly ContextEvidence[];
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
  const collected: ContextEvidence[] = [];

  for (const source of sources) {
    try {
      const result = await source.search(parsed);

      reports.push({
        sourceId: source.id,
        status: result.evidence.length > 0 ? "ok" : "empty",
        evidenceCount: result.evidence.length,
      });
      collected.push(...result.evidence);
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
