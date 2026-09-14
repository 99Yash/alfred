import {
  sourceManifestSchema,
  type ContextSearchRequest,
  type EvidenceCard,
  type SourceManifest,
} from "@alfred/contracts";

/**
 * The source-side shapes (#422; ADR-0101).
 *
 * These live here — not in a `types.ts` grab-bag — because the registry is
 * their narrowest stable owner: it stores `Map<string, ContextSource>` and is
 * the only reader of `source.id`. `search.ts` owns the read-side answer
 * (`ContextSearchResult` and its reports); both files import the shared element
 * from `@alfred/contracts`, so the evidence element has one home both sides
 * agree on.
 *
 * The element itself is the canonical `EvidenceCard` in `@alfred/contracts`
 * (#423): a card carries its own `source.id`, which must equal the
 * `ContextSource.id` that produced it, so the manifest (#466) and the boundary
 * share one identity space. `searchContext` enforces that equality per card at
 * the boundary; a mismatch is rejected, never trusted from the adapter.
 *
 * Since #466 a source also carries its capability manifest, and registration is
 * where that manifest is validated. Describing itself is therefore not an
 * optional extra a source can forget: it is part of what registering MEANS. See
 * `manifest.ts` for what the boundary then does with the declaration.
 */

/** What one registered source returns. Errors are reported, not thrown through. */
export interface ContextSourceResult {
  /** Canonical evidence cards, bounded by the source. */
  readonly evidence: readonly EvidenceCard[];
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
   * Stable source id. The source capability manifest (#466) keys on this id,
   * so a native integration and an MCP-backed source describe themselves the
   * same way.
   */
  readonly id: string;
  /**
   * What this source can know and how it can be read (#466).
   *
   * Required, and `manifest.id` must equal `id`. A source that knows almost
   * nothing about itself still declares that much — `{ id, kind: "mcp" }` is a
   * valid manifest — and the boundary reads the silence conservatively rather
   * than the source going undescribed. Making it optional would have created a
   * second, quieter degradation path for exactly the case the manifest exists
   * to handle.
   */
  readonly manifest: SourceManifest;
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
 *
 * The manifest is parsed here, not at read time. A malformed manifest is a
 * composition-root bug that should stop a boot, and parsing once means every
 * later reader — candidate selection, the priority fold, a catalog page — works
 * on a value the contract has already accepted.
 */
export function registerContextSource(source: ContextSource): () => void {
  const existing = registeredSources.get(source.id);

  if (existing === source) return () => {};

  if (existing !== undefined) {
    throw new Error(`A context search source is already registered for id "${source.id}"`);
  }

  const manifest = sourceManifestSchema.parse(source.manifest);

  if (manifest.id !== source.id) {
    throw new Error(
      `Context search source "${source.id}" declares a manifest for id "${manifest.id}"`,
    );
  }

  registeredSources.set(source.id, source);

  return () => {
    if (registeredSources.get(source.id) === source) registeredSources.delete(source.id);
  };
}

/** Registered sources, in registration order. The manifest reader (#466) enumerates them here. */
export function listContextSources(): readonly ContextSource[] {
  return [...registeredSources.values()];
}
