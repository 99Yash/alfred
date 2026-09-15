import {
  retrievalSourceManifestSchema,
  sourceManifestExpansionKinds,
  type ContextSearchRequest,
  type EvidenceCard,
  type EvidenceExpansionHandle,
  type RetrievalSourceManifest,
  type SourceReadCapability,
} from "@alfred/contracts";

/**
 * Why a READER declined to be asked on one read (#1078).
 *
 * The registry owns this half of the exclusion union because readers are the
 * registry's side of the boundary: only the source itself can know these
 * per-user, per-read facts, and no boot-time manifest can carry them.
 * `manifest.ts` owns the other half (what selection excludes from declared
 * capability) and joins the two as `SourceExclusionReason` for reports.
 *
 * - `not-connected`: no active credential exists — the user never connected.
 * - `missing-scope`: a credential exists but grants none of the scopes this
 *   source needs — the user connected but did not grant access.
 * - `needs-reauth`: the credential's refresh grant is dead (revoked, withdrawn
 *   consent) — the user must reconnect.
 */
export const READER_DECLINED_REASONS = ["not-connected", "missing-scope", "needs-reauth"] as const;

export type ReaderDeclinedReason = (typeof READER_DECLINED_REASONS)[number];

/**
 * The source-side shapes (#422; ADR-0101).
 *
 * These live here — not in a `types.ts` grab-bag — because the registry is
 * their narrowest stable owner: it stores `Map<string, ContextSource>`.
 * `search.ts` owns the read-side answer (`ContextSearchResult` and its
 * reports) and enumerates the registry through `listContextSources`;
 * `manifest.ts` reads each `source.id` twice (selection exclusions and
 * per-source priorities). Both files import the shared element
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
  /**
   * The source declining to be asked at all, for a reason only it could know
   * (#1078).
   *
   * `selectContextSources` prices and screens a source from its manifest, which
   * is parsed once at boot and is the same for every read. Some reasons are not
   * like that: whether the user has connected the account behind a native
   * source is a per-user, per-read fact, and no boot-time declaration can carry
   * it. A reader that learns such a reason BEFORE it calls its provider returns
   * it here, and the boundary reports `skipped` with it.
   *
   * It exists so that fact does not have to wear one of the two wrong words it
   * would otherwise take. `empty` claims the source was asked and had nothing,
   * which would let a consumer close a loop on evidence that was never sought;
   * `error` claims a failure, which would put a routine disconnected account in
   * the packer's urgent notes beside a real outage. Both are the honesty rule
   * of ADR-0101 sub-decision 4 read backwards.
   *
   * It is honored only when the source returned no evidence and no reader
   * failed, so a source that declined one read and answered another reports
   * what it actually produced.
   */
  readonly skipped?: ReaderDeclinedReason | undefined;
}

/** One capability's reader: how this source answers one declared read. */
export type ContextSourceReader = (
  request: ContextSearchRequest,
  signal: AbortSignal,
) => Promise<ContextSourceResult>;

/**
 * The `expand` reader: how this source dereferences one handle (#1077).
 *
 * It takes a handle as well as the request, because expansion answers a
 * different question from the other four capabilities. They answer
 * `request.query` (or `request.objects`); this one answers "read the record
 * behind this card". A reader that could not see the handle would have to infer
 * the record from the query, which is the fuzzy guess the handle exists to
 * replace.
 *
 * It takes the phase's abort signal as well, because the phase is the read's
 * only network cost and one hung provider must not hang the read. The phase
 * aborts the signal at `CONTEXT_SEARCH_EXPANSION_TIMEOUT_MS` and stops
 * waiting for stragglers, so an expander should cancel cheaply on abort
 * rather than finish a doomed round trip.
 *
 * It returns the refreshed card or `undefined`: the expansion phase REPLACES
 * a ranked card rather than appending evidence, so the domain is 0-or-1 and a
 * list return would let a second card silently drop. `undefined` is the honest
 * empty answer — the record behind the handle is gone, or the provider had
 * nothing to add — and the original card stays.
 */
export type ContextSourceExpander = (args: {
  readonly request: ContextSearchRequest;
  readonly handle: EvidenceExpansionHandle;
  readonly signal: AbortSignal;
}) => Promise<EvidenceCard | undefined>;

/**
 * What a source can actually do, keyed by capability.
 *
 * This is the implementation side of `manifest.read`. A source that teaches
 * itself to read `request.query` adds a `keyword_search` (or
 * `semantic_search`) entry here, and a source that drops a reader deletes its
 * entry — either way the manifest follows, because the manifest's `read` is
 * derived from these keys (see {@link defineContextSource}) and registration
 * rejects any other drift. A declared capability with no reader, and a reader
 * with no declaration, both fail at boot rather than shipping a dead
 * capability or an undeclared read.
 *
 * `expand` carries {@link ContextSourceExpander} and every other capability
 * carries {@link ContextSourceReader}, so the mapped type is what stops a
 * handle-blind function from being installed as an expander.
 */
export type ContextSourceReads = {
  readonly [K in SourceReadCapability]?: K extends "expand"
    ? ContextSourceExpander
    : ContextSourceReader;
};

/**
 * A read-only evidence source. Implementations are registered by id, so the
 * source set is data, never a switch.
 *
 * Each `reads` entry must be read-only: no provider writes, no action staging,
 * and no cost-bearing side effect beyond the read itself. Provider-specific
 * action tools stay separate and are never invoked by the boundary.
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
   * Required. It takes the strict retrieval subtype: at least one read
   * capability and an authority above `unknown`. `SourceManifest` stays loose
   * for the catalog case, but a registered source is always a trusted
   * retrieval source — a forgotten declaration fails at boot rather than
   * going dark behind a `skipped` line.
   *
   * The registry mints `manifest.id` from `id` (see
   * {@link defineContextSource}), so the stable id is stated once per source,
   * not once beside the manifest and once on it.
   *
   * Parsed and frozen once at registration: `availability` is a boot-time
   * statement, not a live health reading, and a mid-read failure reports
   * `error` rather than moving this value.
   *
   * `manifest.read` always equals the keys of {@link ContextSource.reads}:
   * adapters build both through {@link defineContextSource} so the two cannot
   * drift, and registration rejects a hand-built source where they differ.
   */
  readonly manifest: RetrievalSourceManifest;
  /** The readers this source implements, keyed by the capability each answers. */
  readonly reads: ContextSourceReads;
}

interface RegisteredSlot {
  /** The exact instance the composition root installed. */
  readonly instance: ContextSource;
  /** The parsed, unknown-key-stripped, frozen manifest for every later reader. */
  readonly manifest: RetrievalSourceManifest;
}

const registeredSources = new Map<string, RegisteredSlot>();

/**
 * Build a source whose manifest cannot drift from its implementation (#466).
 *
 * The stable id is stated once, here: the returned source carries
 * `id` alongside a `manifest` whose `id` the registry minted from it, parsed
 * as a `RetrievalSourceManifest`. `reads` is the single source of truth for
 * `manifest.read`: the returned source carries `read: Object.keys(reads)`
 * alongside the rest of `manifest`. Teaching the source a new capability
 * means adding a `reads` entry (which declares it); deleting a reader removes
 * the declaration. Adapters must build through here rather than writing `id`
 * or `read` literally beside a `search` body.
 */
export function defineContextSource(args: {
  readonly id: string;
  readonly manifest: Omit<RetrievalSourceManifest, "id" | "read">;
  readonly reads: ContextSourceReads;
}): ContextSource {
  // SAFETY: keys of a Partial<Record<SourceReadCapability, …>> are capabilities by construction.
  const read = Object.keys(args.reads) as SourceReadCapability[];
  const manifest = retrievalSourceManifestSchema.parse({ ...args.manifest, id: args.id, read });

  assertReadsMatchManifest(args.reads, manifest);
  assertExpansionDeclaration(manifest);

  return { id: args.id, manifest: deepFreezeManifest(manifest), reads: args.reads };
}

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
 *
 * Registration also binds the manifest to the implementation: the set of
 * `manifest.read` must equal the set of `reads` keys, in both directions, so a
 * declared capability with no reader and a reader with no declaration both
 * throw here.
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

  assertReadsMatchManifest(source.reads, manifest);
  assertExpansionDeclaration(manifest);

  registeredSources.set(source.id, { instance: source, manifest: deepFreezeManifest(manifest) });

  return () => {
    if (registeredSources.get(source.id)?.instance === source) registeredSources.delete(source.id);
  };
}

/** Registered sources, in registration order. Only `searchContext` enumerates them. */
export function listContextSources(): readonly ContextSource[] {
  return [...registeredSources.values()].map((slot) => ({
    ...slot.instance,
    manifest: slot.manifest,
  }));
}

function assertReadsMatchManifest(
  reads: ContextSourceReads,
  manifest: RetrievalSourceManifest,
): void {
  const declared = new Set<string>(manifest.read);

  // SAFETY: keys of a Partial<Record<SourceReadCapability, …>> are capabilities by construction.
  const implemented = new Set<string>(
    (Object.keys(reads) as SourceReadCapability[]).filter(
      (capability) => reads[capability] !== undefined,
    ),
  );

  for (const capability of declared) {
    if (!implemented.has(capability)) {
      throw new Error(
        `Context search source "${manifest.id}" declares read capability "${capability}" with no reader`,
      );
    }
  }

  for (const capability of implemented) {
    if (!declared.has(capability)) {
      throw new Error(
        `Context search source "${manifest.id}" implements read capability "${capability}" with no declaration`,
      );
    }
  }
}

/**
 * Bind the `expand` capability to the handle kinds it dereferences, in both
 * directions (#1077).
 *
 * Each half without the other is a source that registers and then routes
 * nothing, and neither half can be inferred from the other. A source that
 * claims `expand` and names no kind is unreachable: the expansion phase routes
 * by kind alone, so no handle ever reaches it. A source that names kinds and
 * does not claim `expand` has no reader to run, because the capability is
 * derived from the readers that exist. Both are silent dead declarations, which
 * is exactly the failure the manifest contract exists to stop, so both stop the
 * boot instead.
 */
function assertExpansionDeclaration(manifest: RetrievalSourceManifest): void {
  const declaresExpand = manifest.read.includes("expand");
  const kinds = sourceManifestExpansionKinds(manifest);

  if (declaresExpand && kinds.length === 0) {
    throw new Error(
      `Context search source "${manifest.id}" declares read capability "expand" with no expansion handle kinds`,
    );
  }

  if (!declaresExpand && kinds.length > 0) {
    throw new Error(
      `Context search source "${manifest.id}" declares expansion handle kinds with no "expand" read capability`,
    );
  }
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
