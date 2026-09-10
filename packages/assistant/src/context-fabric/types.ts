import type { ContextSearchRequest } from "./contracts";

/**
 * The read-boundary types (#422).
 *
 * The boundary is deliberately narrow: a query/task envelope in, a bounded,
 * source-attributed evidence list out. Source adapters (#424, #425, #428) and
 * the deterministic ranker (#427) plug in behind `ContextSource`; nothing here
 * names a concrete integration, so a new native integration or an MCP-backed
 * source joins by registering an adapter, with no edit to chat, briefing,
 * todos, or meeting-prep callers.
 *
 * `ContextEvidence` is a PROVISIONAL card. The canonical `EvidenceCard`
 * contract and context-packing rules are defined by #423; until then this is
 * the minimal typed element the empty result needs. Consumers may rely on
 * `id` / `sourceId` / `snippet`; the rest is expected to be replaced by (or
 * derived from) #423's contract.
 */

/** Coarse media class of an evidence item. Text today; page/visual kinds later (#429). */
export type ContextMediaType = "text" | "object" | "media";

/**
 * One piece of retrieved evidence, already bounded for model context.
 *
 * Raw provider bodies and binary bytes never ride here. A source that can
 * expand a thin hit puts an opaque `expansionHandle` on the card instead
 * (#428), and a source that cannot answer says so in its report rather than
 * guessing.
 */
export interface ContextEvidence {
  /** Stable id, unique within one result set. */
  readonly id: string;
  /** The `ContextSource.id` that produced this evidence. */
  readonly sourceId: string;
  readonly mediaType: ContextMediaType;
  /** A bounded text preview. Never raw bytes. */
  readonly snippet: string;
  /** Adapter-supplied relevance score; higher is more relevant. */
  readonly score: number;
  /** Citation locator (document id, object key, URL) when the source can give one. */
  readonly citation?: string | undefined;
  /** Opaque handle a later live drill-down can expand (#428). */
  readonly expansionHandle?: string | undefined;
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
 * tools stay separate and are never invoked by the fabric.
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
