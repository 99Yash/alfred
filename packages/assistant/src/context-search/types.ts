import type { ContextSearchRequest } from "@alfred/contracts";

/**
 * The read-boundary types (#422; ADR-0101).
 *
 * The boundary is deliberately narrow: a query/task envelope in, a bounded,
 * source-attributed evidence list out. Source adapters (#424, #425, #428) and
 * the deterministic ranker (#427) plug in behind `ContextSource`; nothing here
 * names a concrete integration, so a new native integration or an MCP-backed
 * source joins by registering an adapter.
 *
 * These are module-internal types. The barrel publishes only `searchContext`,
 * `registerContextSource`, `listContextSources`, `ContextSearchRequest`, and
 * `ContextSource`. The evidence element below is a placeholder, not a contract
 * consumers may build on: #423 owns the canonical EvidenceCard and the packing
 * rules, and may replace this shape outright.
 */

/**
 * One piece of retrieved evidence, already bounded for model context.
 *
 * This is the minimum the empty result needs, not a promise. It carries no
 * score, citation, media kind, or expansion handle yet — those had no producer
 * in this slice and #423 decides their shape. Raw provider bodies and binary
 * bytes never ride here.
 */
export interface ContextEvidence {
  /** Stable id, unique within one result set. */
  readonly id: string;
  /** The `ContextSource.id` that produced this evidence. */
  readonly sourceId: string;
  /** A bounded text preview. Never raw bytes. */
  readonly snippet: string;
}

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

/** What one registered source returns. Errors are reported, not thrown through. */
export interface ContextSourceResult {
  readonly evidence: readonly ContextEvidence[];
}

/**
 * A read-only evidence source. Implementations are registered by id, so the
 * source set is data, never a switch.
 *
 * `search` must be read-only: no provider writes, no action staging, and no
 * cost-bearing side effect beyond the read itself. Provider-specific action
 * tools stay separate and are never invoked by the boundary.
 */
export interface ContextSource {
  /**
   * Stable source id. The source-capability manifest (#466) keys on this id,
   * so a native integration and an MCP-backed source describe themselves the
   * same way.
   */
  readonly id: string;
  search(request: ContextSearchRequest): Promise<ContextSourceResult>;
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
