import { z } from "zod";
import {
  EVIDENCE_EXPANSION_HANDLE_KIND_MAX_CHARS,
  EVIDENCE_MEDIA_KINDS,
  evidenceAuthoritySchema,
  evidenceFreshnessSchema,
  evidenceMediaKindSchema,
  evidenceSourceKindSchema,
  type EvidenceAuthority,
  type EvidenceMediaKind,
  type EvidenceSourceRef,
} from "./evidence-card";
import { INTEGRATION_DISPLAY_NAMES, INTEGRATION_SLUGS, integrationEntry } from "./integrations";
import { IDENTITY_KINDS, identityKindSchema } from "./user-model";

/**
 * The source capability manifest (ADR-0101): what a source can answer and how to read it.
 * ADR-0093 `INTEGRATIONS` says what an integration can do; shared facts are read from there.
 * `id` is the join key with `ContextSource.id` and `EvidenceCard.source.id`.
 * Most fields are optional: an unknown MCP server may declare only `kind`.
 * Silence never grants trust.
 */

/**
 * How a query reaches the source's records.
 * A source that declares none is callable but not searchable.
 * `expand` reads the record behind a card's expansion handle and needs
 * {@link SourceManifest.expansionKinds}; registration rejects either without the other (#1077).
 * `enumerate` ignores the question, so it alone never makes a source selectable.
 */
export const SOURCE_READ_CAPABILITIES = [
  "semantic_search",
  "keyword_search",
  "exact_lookup",
  "enumerate",
  "expand",
] as const;

export type SourceReadCapability = (typeof SOURCE_READ_CAPABILITIES)[number];

export const sourceReadCapabilitySchema = z.enum(SOURCE_READ_CAPABILITIES);

/**
 * Whether Alfred holds a local copy of the content.
 * `live_only` means every read is a remote call.
 * Distinct from {@link SourceFreshness}, which says how current that copy is.
 */
export const SOURCE_INDEXABILITY_LEVELS = ["indexed", "indexable", "live_only", "unknown"] as const;

export type SourceIndexability = (typeof SOURCE_INDEXABILITY_LEVELS)[number];

export const sourceIndexabilitySchema = z.enum(SOURCE_INDEXABILITY_LEVELS);

/** What one read costs. The ranker's `sourcePriority` weight is small, so cost only breaks ties. */
export const SOURCE_COST_CLASSES = ["local", "remote", "metered", "unknown"] as const;

export type SourceCostClass = (typeof SOURCE_COST_CLASSES)[number];

export const sourceCostClassSchema = z.enum(SOURCE_COST_CLASSES);

/**
 * The most expensive cost class a caller will pay for one read (#1078).
 * Derived from {@link SOURCE_COST_CLASSES} minus `unknown`, so a new class joins both.
 */
export const sourceCostBudgetSchema = sourceCostClassSchema.exclude(["unknown"]);

export type SourceCostBudget = z.infer<typeof sourceCostBudgetSchema>;

/**
 * Whether the source can be read now.
 * `unavailable` is set once at boot, and the boundary skips the source.
 * A mid-process failure is an `error` report, not this field.
 * `unknown` does not mean unavailable: the source is still consulted.
 */
export const SOURCE_AVAILABILITY_STATES = ["available", "unavailable", "unknown"] as const;

export type SourceAvailability = (typeof SOURCE_AVAILABILITY_STATES)[number];

export const sourceAvailabilitySchema = z.enum(SOURCE_AVAILABILITY_STATES);

/** Cap on a freshness window: one year. */
export const SOURCE_FRESHNESS_WINDOW_MAX_MINUTES = 525_600;

/**
 * How current the source's copy normally is.
 * `typical` lets a reader rank a source before it sees a card.
 * An absent `windowMinutes` means the source cannot say, not "never stale".
 */
export const sourceFreshnessSchema = z.object({
  typical: evidenceFreshnessSchema,
  windowMinutes: z.number().int().positive().max(SOURCE_FRESHNESS_WINDOW_MAX_MINUTES).optional(),
});

export type SourceFreshness = z.infer<typeof sourceFreshnessSchema>;

/** Cap on typical latency: ten minutes. */
export const SOURCE_LATENCY_MAX_MS = 600_000;

/** What one read costs in time and money. */
export const sourceCostSchema = z.object({
  class: sourceCostClassSchema,
  /** Typical wall time of one read. A hint, never a timeout. */
  typicalLatencyMs: z.number().int().positive().max(SOURCE_LATENCY_MAX_MS).optional(),
});

export type SourceCost = z.infer<typeof sourceCostSchema>;

/** Cap on the discovery topic list. */
export const SOURCE_DISCOVERY_MAX_TOPICS = 30;

/** Human hints about when to read this source. Nothing branches on them; keep it that way. */
export const sourceDiscoverySchema = z.object({
  /** One line: what this source is good for. */
  summary: z.string().min(1).max(300).optional(),
  /** Loose subject terms such as `deployments`. */
  topics: z.array(z.string().min(1).max(60)).max(SOURCE_DISCOVERY_MAX_TOPICS).optional(),
});

export type SourceDiscovery = z.infer<typeof sourceDiscoverySchema>;

/** Cap on an open string list. */
export const SOURCE_MANIFEST_MAX_LIST = 50;

/** Zod does not dedupe, so each declared list rejects repeats. */
function uniqueValues(values: readonly string[]): boolean {
  return new Set(values).size === values.length;
}

/**
 * One source's capability manifest.
 * The boundary reads `read`, `availability`, `expansionKinds`, `mediaKinds`, `authority`,
 * `freshness.typical`, `cost.class`, and the source-ref fields. The rest are catalog-reserved:
 * nothing branches on them yet, and production manifests leave them unset.
 */
export const sourceManifestSchema = z.object({
  /** Equals `ContextSource.id` and `EvidenceCard.source.id`. */
  id: z.string().min(1).max(200),
  /** Structural trust signal. Never a name switch. */
  kind: evidenceSourceKindSchema,
  /**
   * The ADR-0093 integration this source reads. Display name and host come from `INTEGRATIONS`.
   * Alfred's own stores span every provider and name no slug.
   */
  integration: z.enum(INTEGRATION_SLUGS).optional(),
  /** Set when the source is not an integration or overrides its name. */
  displayName: z.string().min(1).max(200).optional(),
  /** Hosts this source's records live on. */
  domains: z
    .array(z.string().min(1).max(253))
    .max(SOURCE_MANIFEST_MAX_LIST)
    .refine(uniqueValues, "must not contain duplicates")
    .optional(),
  /** Provider object kinds such as `pull_request`. Open strings. */
  objectKinds: z
    .array(z.string().min(1).max(100))
    .max(SOURCE_MANIFEST_MAX_LIST)
    .refine(uniqueValues, "must not contain duplicates")
    .optional(),
  /**
   * The modalities this source can return (#429). Optional here for the catalog case;
   * required on {@link retrievalSourceManifestSchema}.
   * `image` means it can return a picture, not that Alfred can read it.
   */
  mediaKinds: z
    .array(evidenceMediaKindSchema)
    .max(EVIDENCE_MEDIA_KINDS.length)
    .refine(uniqueValues, "must not contain duplicates")
    .optional(),
  /** Silence means callable, not searchable. */
  read: z
    .array(sourceReadCapabilitySchema)
    .max(SOURCE_READ_CAPABILITIES.length)
    .refine(uniqueValues, "must not contain duplicates")
    .optional(),
  /**
   * The `EvidenceCard.expansion` handle kinds this source reads (#1077).
   * Expansion routes a handle by this list alone, never by its `sourceId`.
   * Must pair with the `expand` read capability; a registered source with only one fails at boot.
   */
  expansionKinds: z
    .array(z.string().min(1).max(EVIDENCE_EXPANSION_HANDLE_KIND_MAX_CHARS))
    .max(SOURCE_MANIFEST_MAX_LIST)
    .refine(uniqueValues, "must not contain duplicates")
    .optional(),
  identityKeys: z
    .array(identityKindSchema)
    .max(IDENTITY_KINDS.length)
    .refine(uniqueValues, "must not contain duplicates")
    .optional(),
  freshness: sourceFreshnessSchema.optional(),
  indexability: sourceIndexabilitySchema.optional(),
  /** An undeclared source is never promoted toward `high`. */
  authority: evidenceAuthoritySchema.optional(),
  cost: sourceCostSchema.optional(),
  discovery: sourceDiscoverySchema.optional(),
  /** Absent reads as `unknown`, not `unavailable`. */
  availability: sourceAvailabilitySchema.optional(),
});

export type SourceManifest = z.infer<typeof sourceManifestSchema>;

/**
 * The strict manifest a registered `ContextSource` takes: at least one read capability,
 * an authority above `unknown`, and at least one media kind (#429).
 * A source that misses one fails at boot instead of going dark.
 * The boundary rejects a card whose modality the source did not declare,
 * so silence must not admit everything.
 */
export const retrievalSourceManifestSchema = sourceManifestSchema.safeExtend({
  read: sourceManifestSchema.shape.read.unwrap().min(1),
  authority: evidenceAuthoritySchema.safeExtend({ level: z.enum(["high", "medium", "low"]) }),
  mediaKinds: sourceManifestSchema.shape.mediaKinds.unwrap().min(1),
});

export type RetrievalSourceManifest = z.infer<typeof retrievalSourceManifestSchema>;

/**
 * The display name: its own, else the ADR-0093 integration's, else the id.
 * A manifest never restates an integration name, so a rename carries through.
 */
export function sourceManifestDisplayName(manifest: SourceManifest): string {
  if (manifest.displayName !== undefined) return manifest.displayName;

  if (manifest.integration !== undefined) {
    return INTEGRATION_DISPLAY_NAMES[manifest.integration];
  }

  return manifest.id;
}

/** The source hosts: its own list, else the integration's `domain`, else none. */
export function sourceManifestDomains(manifest: SourceManifest): readonly string[] {
  if (manifest.domains !== undefined) return manifest.domains;

  if (manifest.integration !== undefined) {
    const entry = integrationEntry(manifest.integration);

    if ("domain" in entry) return [entry.domain];
  }

  return [];
}

/** The expansion handle kinds this source reads (#1077). Empty when it declares none. */
export function sourceManifestExpansionKinds(manifest: SourceManifest): readonly string[] {
  return manifest.expansionKinds ?? [];
}

/** Whether the source declared this modality (#429). Silence answers `false`. */
export function sourceManifestDeclaresMediaKind(
  manifest: SourceManifest,
  mediaKind: EvidenceMediaKind,
): boolean {
  return manifest.mediaKinds?.includes(mediaKind) === true;
}

/** Whether the source declared it can be read this way. */
export function sourceManifestSupportsRead(
  manifest: SourceManifest,
  capability: SourceReadCapability,
): boolean {
  return manifest.read?.includes(capability) === true;
}

/** Whether the source declared any read capability. */
export function declaresReadSemantics(manifest: SourceManifest): boolean {
  return (manifest.read?.length ?? 0) > 0;
}

/**
 * The card source ref for a manifest's own cards.
 * Omits `displayName` when the manifest has none, so the packer never renders `id [id]`.
 */
export function sourceRefFromManifest(manifest: SourceManifest): EvidenceSourceRef {
  const domains = sourceManifestDomains(manifest);
  const domain = domains[0] !== undefined ? { domain: domains[0] } : {};

  if (manifest.displayName !== undefined || manifest.integration !== undefined) {
    return {
      id: manifest.id,
      kind: manifest.kind,
      displayName: sourceManifestDisplayName(manifest),
      ...domain,
    };
  }

  return { id: manifest.id, kind: manifest.kind, ...domain };
}

/** Copy the manifest authority for a card. The registry manifest is frozen, so never alias it. */
export function sourceAuthorityFromManifest(
  manifest: SourceManifest,
): EvidenceAuthority | undefined {
  const authority = manifest.authority;

  if (authority === undefined) return undefined;

  return authority.label !== undefined
    ? { level: authority.level, label: authority.label }
    : { level: authority.level };
}
