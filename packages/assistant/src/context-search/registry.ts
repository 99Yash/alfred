import {
  retrievalSourceManifestSchema,
  type ContextSearchRequest,
  type EvidenceCard,
  type RetrievalSourceManifest,
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
   * Required, and `manifest.id` must equal `id`. It takes the strict retrieval
   * subtype: at least one read capability and an authority above `unknown`.
   * `SourceManifest` stays loose for the catalog case, but a registered source
   * is always a trusted retrieval source — a forgotten declaration fails at
   * boot rather than going dark behind a `skipped` line.
   *
   * Parsed and frozen once at registration: `availability` is a boot-time
   * statement, not a live health reading, and a mid-read failure reports
   * `error` rather than moving this value.
   */
  readonly manifest: RetrievalSourceManifest;
  search(request: ContextSearchRequest): Promise<ContextSourceResult>;
}

interface RegisteredSlot {
  /** The exact instance the composition root installed. */
  readonly instance: ContextSource;
  /** The parsed, unknown-key-stripped, frozen manifest for every later reader. */
  readonly manifest: RetrievalSourceManifest;
}

const registeredSources = new Map<string, RegisteredSlot>();

/**
 * Register a read-only evidence source. A composition root calls this at boot
 * (#424+); the boundary itself never imports a concrete source.
 *
 * Installing the same instance again is a no-op, so a repeat boot call in one
 * process does not throw. Installing a different instance under a live id
 * throws — a duplicate id is a bug, not a reconfiguration. Returns a disposer
 * that clears the slot only while it still holds this exact source.
 *
 * The manifest is parsed here, not at read time, and the registry stores the
 * PARSED value beside the original instance — never the caller's object. A
 * malformed manifest, an unknown key, or a missing read/authority declaration
 * is a composition-root bug that stops the boot, and every later reader works
 * on a frozen value the contract has already accepted. Mutating the caller's
 * manifest after registration cannot move the registry.
 */
export function registerContextSource(source: ContextSource): () => void {
  const existing = registeredSources.get(source.id);

  if (existing?.instance === source) return () => {};

  if (existing !== undefined) {
    throw new Error(`A context search source is already registered for id "${source.id}"`);
  }

  const manifest = retrievalSourceManifestSchema.parse(source.manifest);

  if (manifest.id !== source.id) {
    throw new Error(
      `Context search source "${source.id}" declares a manifest for id "${manifest.id}"`,
    );
  }

  registeredSources.set(source.id, { instance: source, manifest: deepFreezeManifest(manifest) });

  return () => {
    if (registeredSources.get(source.id)?.instance === source) registeredSources.delete(source.id);
  };
}

/** Registered sources, in registration order. The manifest reader (#466) enumerates them here. */
export function listContextSources(): readonly ContextSource[] {
  return [...registeredSources.values()].map((slot) => ({
    ...slot.instance,
    manifest: slot.manifest,
  }));
}

/**
 * Deep-freeze a parsed manifest so no later reader — and no later mutation of
 * a returned reference — can change what the registry accepted. Plain JSON
 * data only: objects freeze recursively, arrays freeze element-wise.
 */
function deepFreezeManifest(manifest: RetrievalSourceManifest): RetrievalSourceManifest {
  deepFreezeValue(manifest);

  return manifest;
}

function deepFreezeValue(value: unknown): void {
  if (Array.isArray(value)) {
    for (const entry of value) deepFreezeValue(entry);

    Object.freeze(value);

    return;
  }

  if (typeof value === "object" && value !== null) {
    for (const entry of Object.values(value)) deepFreezeValue(entry);

    Object.freeze(value);
  }
}
