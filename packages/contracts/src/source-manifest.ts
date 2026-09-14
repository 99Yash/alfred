import { z } from "zod";
import {
  evidenceAuthoritySchema,
  evidenceFreshnessSchema,
  evidenceMediaKindSchema,
  evidenceSourceKindSchema,
} from "./evidence-card";
import { INTEGRATION_DISPLAY_NAMES, INTEGRATION_SLUGS, integrationEntry } from "./integrations";
import { identityKindSchema } from "./user-model";

/**
 * The source capability manifest (#466; epic #422; ADR-0101).
 *
 * A manifest is one source's own statement of what it can know and how it can
 * be read. It is the source-DISCOVERY contract, and it is deliberately separate
 * from the tool registry: ADR-0093's `INTEGRATIONS` record says what an
 * integration can DO (its actions, its credential, its passthrough transport),
 * while a manifest says what a registered evidence source can ANSWER. A native
 * integration names its slug here and the shared facts — display name, domain —
 * are read back out of that record, so the two never carry two spellings of the
 * same fact.
 *
 * `id` is the join key. It equals the producing `ContextSource.id` and the
 * `EvidenceCard.source.id` of every card that source returns, so a card, a
 * ranking row, and a manifest all address one source without a translation
 * table.
 *
 * Almost every field is optional, and that is the contract's point rather than
 * laxity. An MCP server Alfred has never seen can describe itself in one field
 * (`kind: "mcp"`) and no more. The reader's job is to treat that silence
 * conservatively — {@link isTrustedRetrievalSource} answers `false` for it — not
 * to invent a value for it. Declaration grants trust; silence never does.
 *
 * Pure module, no Node imports: the web catalog and the server boundary read
 * the same shape.
 */

/**
 * What a source can be ASKED for. This is read semantics, not a tool list: it
 * says how a query reaches the source's records, so the boundary can tell a
 * searchable source from a merely callable one.
 *
 * - `semantic_search` — ranked retrieval over an embedding or equivalent index.
 * - `keyword_search` — literal term matching over the same records.
 * - `exact_lookup` — resolve a caller-declared identity or key to one record.
 * - `enumerate` — list recent records with no query at all.
 * - `expand` — dereference an `EvidenceCard.expansion` handle into live
 *   provider data (#428).
 *
 * A source that declares none of these is callable and not searchable. That is
 * the undescribed-MCP case, and it is why the list is a declaration rather than
 * something inferred from the fact that a tool exists.
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
 * Whether Alfred holds a local copy of the source's content.
 *
 * `indexed` means the content is in a local index now, `indexable` means it
 * could be ingested but is not, `live_only` means the provider is the only copy
 * and every read is a remote call, and `unknown` is the honest tail. This is a
 * property of the CONTENT, distinct from {@link SourceFreshness}, which is a
 * property of how current that copy is.
 */
export const SOURCE_INDEXABILITY_LEVELS = ["indexed", "indexable", "live_only", "unknown"] as const;

export type SourceIndexability = (typeof SOURCE_INDEXABILITY_LEVELS)[number];

export const sourceIndexabilitySchema = z.enum(SOURCE_INDEXABILITY_LEVELS);

/**
 * What one read of the source costs.
 *
 * `local` reads a local store, `remote` calls a provider over the network,
 * `metered` costs money per read (a provider that bills calls, an embedding),
 * and `unknown` is the honest tail. A cheap source is preferred on a tie, never
 * over relevance — the ranker's `sourcePriority` weight is small for exactly
 * this reason.
 */
export const SOURCE_COST_CLASSES = ["local", "remote", "metered", "unknown"] as const;

export type SourceCostClass = (typeof SOURCE_COST_CLASSES)[number];

export const sourceCostClassSchema = z.enum(SOURCE_COST_CLASSES);

/**
 * Whether the source can be read AT ALL right now.
 *
 * `unavailable` is a source's own admission — a disconnected integration, an
 * MCP connection that needs reauthorization — and the boundary does not consult
 * it. `unknown` is NOT read as unavailable: silence is not a confession, so an
 * undeclared source is still consulted and reports its own outcome. A source
 * that becomes unusable mid-read is an `error` report, not this field.
 */
export const SOURCE_AVAILABILITY_STATES = ["available", "unavailable", "unknown"] as const;

export type SourceAvailability = (typeof SOURCE_AVAILABILITY_STATES)[number];

export const sourceAvailabilitySchema = z.enum(SOURCE_AVAILABILITY_STATES);

/** Ceiling on a declared freshness window, in minutes: one year. */
export const SOURCE_FRESHNESS_WINDOW_MAX_MINUTES = 525_600;

/**
 * How current the source's copy normally is.
 *
 * `typical` is the `EvidenceTime.freshness` its cards normally declare, so a
 * reader can rank a source before it has seen one card. `windowMinutes` is the
 * age past which the source's own copy should be read as stale; an absent
 * window means the source cannot say, never "never stale".
 */
export const sourceFreshnessSchema = z.object({
  typical: evidenceFreshnessSchema,
  windowMinutes: z.number().int().positive().max(SOURCE_FRESHNESS_WINDOW_MAX_MINUTES).optional(),
});

export type SourceFreshness = z.infer<typeof sourceFreshnessSchema>;

/** Ceiling on a declared typical latency, in milliseconds: ten minutes. */
export const SOURCE_LATENCY_MAX_MS = 600_000;

/** What one read costs in time and money. Both readings are declarations. */
export const sourceCostSchema = z.object({
  class: sourceCostClassSchema,
  /** Typical wall time of one read. A hint for budgeting, never a timeout. */
  typicalLatencyMs: z.number().int().positive().max(SOURCE_LATENCY_MAX_MS).optional(),
});

export type SourceCost = z.infer<typeof sourceCostSchema>;

/** Ceiling on the discovery topic list. A hint set, not a routing table. */
export const SOURCE_DISCOVERY_MAX_TOPICS = 30;

/**
 * Human-facing hints about when this source is worth reading.
 *
 * These are prose and loose terms for a person reading a trace or a catalog
 * page. Nothing in the boundary branches on them: a hint that became a router
 * would be the hard-coded source switch this whole contract exists to remove.
 */
export const sourceDiscoverySchema = z.object({
  /** One line: what this source is good for. */
  summary: z.string().min(1).max(300).optional(),
  /** Loose subject terms — `deployments`, `meeting notes`. */
  topics: z.array(z.string().min(1).max(60)).max(SOURCE_DISCOVERY_MAX_TOPICS).optional(),
});

export type SourceDiscovery = z.infer<typeof sourceDiscoverySchema>;

/** Ceiling on each declared list, so one manifest cannot grow unbounded. */
export const SOURCE_MANIFEST_MAX_LIST = 50;

/**
 * One source's capability manifest.
 *
 * Read it as four groups: WHO the source is (`id`, `kind`, `integration`,
 * `displayName`, `domains`), WHAT it holds (`objectKinds`, `mediaKinds`,
 * `identityKeys`), HOW it can be read (`read`, `indexability`, `freshness`,
 * `availability`), and HOW MUCH to trust and spend (`authority`, `cost`,
 * `discovery`).
 */
export const sourceManifestSchema = z.object({
  /** The join key: the producing `ContextSource.id` and `EvidenceCard.source.id`. */
  id: z.string().min(1).max(200),
  /** Structural trust signal, shared with the card contract. Never a name switch. */
  kind: evidenceSourceKindSchema,
  /**
   * The ADR-0093 integration this source reads, when it reads one.
   *
   * This is the whole non-duplication mechanism: a native source names its slug
   * and {@link sourceManifestDisplayName} / {@link sourceManifestDomains} read
   * the display name and host back out of `INTEGRATIONS`. Alfred's own stores
   * (the corpus, memory, object state) span every ingested provider and name no
   * slug.
   */
  integration: z.enum(INTEGRATION_SLUGS).optional(),
  /** Display name, when the source is not an integration or overrides it. */
  displayName: z.string().min(1).max(200).optional(),
  /** Hosts this source's records live on, for grouping and citation. */
  domains: z.array(z.string().min(1).max(253)).max(SOURCE_MANIFEST_MAX_LIST).optional(),
  /** Provider-declared object kinds — `pull_request`, `issue`. Open strings. */
  objectKinds: z.array(z.string().min(1).max(100)).max(SOURCE_MANIFEST_MAX_LIST).optional(),
  /** Payload modalities this source can return. */
  mediaKinds: z.array(evidenceMediaKindSchema).max(SOURCE_MANIFEST_MAX_LIST).optional(),
  /** How a query reaches the records. Silence means callable, not searchable. */
  read: z.array(sourceReadCapabilitySchema).max(SOURCE_MANIFEST_MAX_LIST).optional(),
  /** Identity kinds this source can resolve or attach to its evidence. */
  identityKeys: z.array(identityKindSchema).max(SOURCE_MANIFEST_MAX_LIST).optional(),
  freshness: sourceFreshnessSchema.optional(),
  indexability: sourceIndexabilitySchema.optional(),
  /** Provenance trust. An undeclared source is never promoted toward `high`. */
  authority: evidenceAuthoritySchema.optional(),
  cost: sourceCostSchema.optional(),
  discovery: sourceDiscoverySchema.optional(),
  /** Whether the source can be read now. Absent reads as `unknown`, not `unavailable`. */
  availability: sourceAvailabilitySchema.optional(),
});

export type SourceManifest = z.infer<typeof sourceManifestSchema>;

/**
 * The display name for a source: its own, else the ADR-0093 integration's, else
 * the id. The fallback chain is the point — a manifest that names an
 * integration never restates the name, so renaming an integration renames its
 * source too.
 */
export function sourceManifestDisplayName(manifest: SourceManifest): string {
  if (manifest.displayName !== undefined) return manifest.displayName;

  if (manifest.integration !== undefined) {
    return INTEGRATION_DISPLAY_NAMES[manifest.integration];
  }

  return manifest.id;
}

/**
 * The hosts a source's records live on: its own list, else the ADR-0093
 * integration's single `domain`, else none. A planned or internal integration
 * entry carries no domain, so the empty list is a real answer.
 */
export function sourceManifestDomains(manifest: SourceManifest): readonly string[] {
  if (manifest.domains !== undefined) return manifest.domains;

  if (manifest.integration !== undefined) {
    const entry = integrationEntry(manifest.integration);

    if ("domain" in entry) return [entry.domain];
  }

  return [];
}

/** Whether the source declared it can be read this way. */
export function sourceManifestSupportsRead(
  manifest: SourceManifest,
  capability: SourceReadCapability,
): boolean {
  return manifest.read?.includes(capability) === true;
}

/**
 * Whether the source stated HOW it can be read at all — any read capability.
 *
 * A source with no declared read semantics may still be a perfectly good tool;
 * it is simply not something a retrieval boundary knows how to question.
 */
export function declaresReadSemantics(manifest: SourceManifest): boolean {
  return (manifest.read?.length ?? 0) > 0;
}

/**
 * Whether the source may be treated as a trusted retrieval source.
 *
 * Two declarations are required, and neither can be inferred:
 *
 * 1. **Read semantics.** Without them the boundary cannot say what asking this
 *    source a question even means.
 * 2. **Authority above `unknown`.** A source's own relevance `score` is the
 *    ranker's heaviest feature, and an undescribed source sets that number
 *    itself. Requiring a declared provenance is what stops an unknown MCP
 *    server from ranking itself first by returning `score: 1` on every card.
 *
 * The rule is uniform across `kind`: a first-party source that describes itself
 * as little as a stranger is trusted as little. Trust follows the declaration,
 * never the author.
 */
export function isTrustedRetrievalSource(manifest: SourceManifest): boolean {
  if (!declaresReadSemantics(manifest)) return false;

  const level = manifest.authority?.level;

  return level !== undefined && level !== "unknown";
}
