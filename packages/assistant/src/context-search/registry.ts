import type { ContextSearchRequest } from "@alfred/contracts";

/**
 * The source-side shapes (#422; ADR-0101).
 *
 * These live here — not in a `types.ts` grab-bag — because the registry is
 * their narrowest stable owner: it stores `Map<string, ContextSource>` and is
 * the only reader of `source.id`. `search.ts` owns the read-side answer
 * (`ContextSearchResult` and its reports) and imports the element type from
 * here, so the evidence element has one home both sides agree on.
 *
 * `ContextEvidence` is a module-internal placeholder, not a contract consumers
 * may build on: #423 owns the canonical EvidenceCard and the packing rules,
 * and may replace this shape outright.
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

const registeredSources = new Map<string, ContextSource>();

/**
 * Register a read-only evidence source. A composition root calls this at boot
 * (#424+); the boundary itself never imports a concrete source.
 *
 * Installing the same instance again is a no-op, so a repeat boot call in one
 * process does not throw. Installing a different instance under a live id
 * throws — a duplicate id is a bug, not a reconfiguration. Returns a disposer
 * that clears the slot only while it still holds this exact source.
 */
export function registerContextSource(source: ContextSource): () => void {
  const existing = registeredSources.get(source.id);

  if (existing === source) return () => {};

  if (existing !== undefined) {
    throw new Error(`A context search source is already registered for id "${source.id}"`);
  }

  registeredSources.set(source.id, source);

  return () => {
    if (registeredSources.get(source.id) === source) registeredSources.delete(source.id);
  };
}

/** Registered sources, in registration order. The future manifest reader (#466) enumerates them here. */
export function listContextSources(): readonly ContextSource[] {
  return [...registeredSources.values()];
}
