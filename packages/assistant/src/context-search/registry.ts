import {
  isRecord,
  retrievalSourceManifestSchema,
  sourceManifestDeclaresMediaKind,
  sourceManifestExpansionKinds,
  type ContextSearchRequest,
  type EvidenceCard,
  type EvidenceExpansionHandle,
  type RetrievalSourceManifest,
  type SourceReadCapability,
} from "@alfred/contracts";

/**
 * Per-user reasons a reader declines a read (#1078). Selection's reasons live
 * in `manifest.ts`.
 * - `not-connected`: no active credential.
 * - `missing-scope`: a credential without the needed scopes.
 * - `needs-reauth`: the refresh grant is dead. The user must reconnect.
 */
export const READER_DECLINED_REASONS = ["not-connected", "missing-scope", "needs-reauth"] as const;

export type ReaderDeclinedReason = (typeof READER_DECLINED_REASONS)[number];

/**
 * Source-side shapes (ADR-0101). `searchContext` rejects a card whose
 * `source.id` differs from the source that produced it.
 * Registration validates the manifest (#466). Terms: `docs/reference/glossary.md`.
 */

/** One source's answer. */
export interface ContextSourceResult {
  readonly evidence: readonly EvidenceCard[];
  /**
   * A per-user reason the source declined, which a boot-time manifest cannot
   * carry (#1078). Not `empty` (never asked) and not `error` (not a failure).
   * Honored only when the source returned no evidence and no reader failed.
   */
  readonly skipped?: ReaderDeclinedReason | undefined;
}

export type ContextSourceReader = (
  request: ContextSearchRequest,
  signal: AbortSignal,
) => Promise<ContextSourceResult>;

/**
 * The `expand` reader (#1077): read the record behind one handle.
 * Returns one card or `undefined`, because the card replaces a ranked card.
 * Cancel quickly on abort: the phase stops waiting at
 * `CONTEXT_SEARCH_EXPANSION_TIMEOUT_MS`.
 */
export type ContextSourceExpander = (args: {
  readonly request: ContextSearchRequest;
  readonly handle: EvidenceExpansionHandle;
  readonly signal: AbortSignal;
}) => Promise<EvidenceCard | undefined>;

/**
 * Readers keyed by capability. `manifest.read` derives from these keys
 * ({@link defineContextSource}). The mapped type stops a handle-blind function
 * from being installed as an expander.
 */
export type ContextSourceReads = {
  readonly [K in SourceReadCapability]?: K extends "expand"
    ? ContextSourceExpander
    : ContextSourceReader;
};

/** A read-only evidence source. Readers must not write, stage actions, or call action tools. */
export interface ContextSource {
  /** Stable id. The manifest and every card key on it. */
  readonly id: string;
  /**
   * Required, and strict: at least one read and an authority above `unknown`.
   * Frozen at registration. `availability` is a boot-time claim; a failed read
   * reports `error` and leaves it alone. `read` always equals the keys of `reads`.
   */
  readonly manifest: RetrievalSourceManifest;
  readonly reads: ContextSourceReads;
}

/** Why a card fails the join with its source's manifest. */
export const CARD_MANIFEST_VIOLATIONS = ["source-id-mismatch", "undeclared-media-kind"] as const;

export type CardManifestViolation = (typeof CARD_MANIFEST_VIOLATIONS)[number];

export function cardManifestViolation(
  card: EvidenceCard,
  source: ContextSource,
): CardManifestViolation | undefined {
  if (card.source.id !== source.id) return "source-id-mismatch";

  if (!sourceManifestDeclaresMediaKind(source.manifest, card.mediaKind)) {
    return "undeclared-media-kind";
  }

  return undefined;
}

/**
 * The card's `source.id` matches its source, and its `mediaKind` is declared
 * (#429). Checked here, not in the card schema, because both compare the card
 * to its source. A wrong `source.id` would borrow another source's authority.
 */
export function cardObeysManifest(card: EvidenceCard, source: ContextSource): boolean {
  return cardManifestViolation(card, source) === undefined;
}

interface RegisteredSlot {
  readonly instance: ContextSource;
  /** Parsed, unknown keys stripped, frozen. */
  readonly manifest: RetrievalSourceManifest;
}

const registeredSources = new Map<string, RegisteredSlot>();

/**
 * Build a source whose manifest cannot drift from its readers (#466).
 * `id` is stated once, and `manifest.read` is `Object.keys(reads)`.
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
 * Register a source at boot. The same instance again is a no-op; another
 * instance under a live id throws. The registry stores a parsed, frozen copy
 * of the manifest, so a later edit to the caller's object changes nothing.
 * The disposer clears the slot only while it still holds this source.
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

/** Registered sources, in registration order. */
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
 * `expand` and expansion kinds must come together (#1077). Either one alone
 * registers a source that can never route a handle.
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

/** Freeze the parsed manifest, so no returned reference can change it. Plain JSON only. */
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

  if (isRecord(value)) {
    for (const entry of Object.values(value)) deepFreezeValue(entry);

    Object.freeze(value);
  }
}
