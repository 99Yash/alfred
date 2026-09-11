import { z } from "zod";
import { OBJECT_STATE_CATEGORIES } from "./integration-objects";
import { identityRefSchema } from "./user-model";

/**
 * The canonical cross-integration evidence contract (#423; epic #422; ADR-0101).
 *
 * `EvidenceCard` is the single shape every Context Search source adapter returns
 * and the packer renders for the model. It replaces the provisional
 * module-internal `ContextEvidence` that slice 1 of the epic minted, and it is
 * deliberately source-agnostic: nothing in this file names an integration. The
 * `source.id` is the join key to the source capability manifest (#466), so a
 * native integration and an MCP-backed source describe themselves the same way
 * and a new source is a registration, never a schema edit.
 *
 * Text-first by construction, media-ready without churn: a card always carries a
 * bounded `snippet` and/or an honest `note`, and the optional `anchors`,
 * `object`, and `mediaKind` fields are the extension surface for page, visual,
 * and object-state evidence (#429, #425). A future medium is a new `mediaKind`
 * or anchor member, not a new card shape.
 *
 * Pure module, no Node imports: the web client and the server agree on this
 * shape, and nothing here reads a database or a provider.
 */

/**
 * Hard ceiling on a card's text preview. A source bounds its own snippet too;
 * this is the contract's guarantee, so the packer can trust the input and the
 * model can never receive a full provider body through a card. Characters, not
 * tokens.
 */
export const EVIDENCE_SNIPPET_MAX_CHARS = 2_000;

/**
 * The modality of the evidence payload.
 *
 * `text` is the only kind producible end to end today. `document` and `page`
 * are an ingested document and one page of it; `image`/`audio`/`video` are
 * media that may arrive as placeholders before extraction exists; `unknown` is
 * the honest tail for a source that cannot say. A media card need not carry a
 * snippet — a `note` explains the degraded case instead.
 */
export const EVIDENCE_MEDIA_KINDS = [
  "text",
  "document",
  "page",
  "image",
  "audio",
  "video",
  "unknown",
] as const;

export type EvidenceMediaKind = (typeof EVIDENCE_MEDIA_KINDS)[number];

export const evidenceMediaKindSchema = z.enum(EVIDENCE_MEDIA_KINDS);

/**
 * How a source is backed, so a reader can reason about trust without a
 * name list. `native` is a first-party integration, `internal` is one of
 * Alfred's own stores, `mcp` is a remote MCP server, and `unknown` is the
 * conservative tail for a source that did not declare itself.
 */
export const EVIDENCE_SOURCE_KINDS = ["native", "internal", "mcp", "unknown"] as const;

export type EvidenceSourceKind = (typeof EVIDENCE_SOURCE_KINDS)[number];

export const evidenceSourceKindSchema = z.enum(EVIDENCE_SOURCE_KINDS);

/**
 * Where a card came from. `id` must equal the producing `ContextSource.id`
 * (ADR-0101) and is the key the source capability manifest (#466) registers
 * under, so the two never need a name-string translation table. The remaining
 * fields are display metadata a manifest may supply; `kind` is a structural
 * trust signal, not a source name.
 */
export const evidenceSourceRefSchema = z.object({
  /** Stable manifest id; the join key to the source capability manifest. */
  id: z.string().min(1).max(200),
  /** How the source is backed, for trust and rendering. */
  kind: evidenceSourceKindSchema,
  /** Human name for citations. An unnamed MCP source may omit it. */
  displayName: z.string().min(1).max(200).optional(),
  /** Host for grouping/citation, e.g. `github.com`. Never a name switch. */
  domain: z.string().min(1).max(253).optional(),
});

export type EvidenceSourceRef = z.infer<typeof evidenceSourceRefSchema>;

/**
 * Object identity for deterministic object-state evidence (#425). Every field
 * is an open string because the provider set is data, not this module's enum:
 * `provider` is the integration slug the manifest knows, `kind` is a
 * provider-declared object kind, and `stateCategory` is the provider-agnostic
 * bucket the integration-object registry already owns. A missing category is
 * rendered as "uncategorized", never inferred from `nativeState`.
 */
export const evidenceObjectRefSchema = z.object({
  /** Integration slug — `github`, later `clickup`, `claude-code`. */
  provider: z.string().min(1).max(100),
  /** Object kind within the provider — `pull_request`, `task`. */
  kind: z.string().min(1).max(100),
  /** Provider-native stable id, as a string. */
  externalId: z.string().min(1).max(512),
  /** Provider-agnostic lifecycle bucket; absent when the provider has none. */
  stateCategory: z.enum(OBJECT_STATE_CATEGORIES).optional(),
  /** Raw provider state for display — `open`/`merged`/`closed`. */
  nativeState: z.string().min(1).max(200).optional(),
  title: z.string().min(1).max(500).optional(),
  url: z.string().min(1).max(2_048).optional(),
  /** Provider-specific locator — `owner/repo` for a GitHub PR. */
  repo: z.string().min(1).max(300).optional(),
});

export type EvidenceObjectRef = z.infer<typeof evidenceObjectRefSchema>;

/**
 * One entity a piece of evidence is about (a person, org, or object handle).
 *
 * It is `identityRefSchema` extended with a display form, never a restated
 * object: the owner already carries the byte-bounded `identityValueSchema`, the
 * canonical-form refine, the `identityValueMatchesKind` format refine, and
 * `.strict()`. Deriving here means a card's anchor passes exactly what the
 * stable-entity-id mint chokepoint passes, so a card can never hold a
 * contract-valid entity that then fails projection — the asymmetry
 * `user-model.ts` warns about. Restating the object would silently drop the
 * byte bound, the format check, and the unknown-key rejection.
 */
export const evidenceEntityRefSchema = identityRefSchema.extend({
  /** Display form, when it differs from the canonical value. */
  display: z.string().min(1).max(300).optional(),
});

export type EvidenceEntityRef = z.infer<typeof evidenceEntityRefSchema>;

/**
 * How current a card is. `live` was read from the provider for this search,
 * `ingested` is a local indexed copy, `stale` is an indexed copy beyond its
 * source's freshness window, and `unknown` is the honest default when the
 * source said nothing. Freshness is a declaration, never inferred from a
 * missing timestamp.
 */
export const EVIDENCE_FRESHNESS_VALUES = ["live", "ingested", "stale", "unknown"] as const;

export type EvidenceFreshness = (typeof EVIDENCE_FRESHNESS_VALUES)[number];

export const evidenceFreshnessSchema = z.enum(EVIDENCE_FRESHNESS_VALUES);

/**
 * When the evidence happened, was observed, and entered the corpus. All
 * instants are ISO-8601 strings with an offset. A source reports only what it
 * knows; the packer renders `freshness unknown` rather than guessing from
 * absence.
 */
export const evidenceTimeSchema = z.object({
  /** When the underlying event happened, for event-shaped evidence. */
  occurredAt: z.iso.datetime({ offset: true }).optional(),
  /** When the source observed the record. */
  observedAt: z.iso.datetime({ offset: true }).optional(),
  /** When Alfred indexed or stored the record. */
  indexedAt: z.iso.datetime({ offset: true }).optional(),
  freshness: evidenceFreshnessSchema.optional(),
});

export type EvidenceTime = z.infer<typeof evidenceTimeSchema>;

/**
 * Authority/provenance, snapshotted from the source capability manifest when
 * it declares one. `unknown` is the conservative default: a source that does
 * not declare authority is never promoted to `high` (#427). The ranker reads
 * this; the model only ever sees the rendered form.
 */
export const EVIDENCE_AUTHORITY_LEVELS = ["high", "medium", "low", "unknown"] as const;

export type EvidenceAuthorityLevel = (typeof EVIDENCE_AUTHORITY_LEVELS)[number];

export const evidenceAuthorityLevelSchema = z.enum(EVIDENCE_AUTHORITY_LEVELS);

export const evidenceAuthoritySchema = z.object({
  level: evidenceAuthorityLevelSchema,
  /** Human-readable provenance, e.g. "GitHub App webhook" or "MCP, undescribed". */
  label: z.string().min(1).max(200).optional(),
});

export type EvidenceAuthority = z.infer<typeof evidenceAuthoritySchema>;

/**
 * A citation the model may render as a source link. `url` is optional because
 * an internal record (a memory chunk, an object row) has no public address;
 * `locator` carries a human-facing pointer instead (a page, a message id, a
 * repo path). A card with neither still cites its `source.id` through the
 * header.
 */
export const evidenceCitationSchema = z.object({
  label: z.string().min(1).max(300),
  url: z.string().min(1).max(2_048).optional(),
  locator: z.string().min(1).max(500).optional(),
});

export type EvidenceCitation = z.infer<typeof evidenceCitationSchema>;

/**
 * The anchor kinds the contract admits today: a page in a document and a
 * visual region in an image/scan. `unknown` is the honest tail. A future
 * anchor kind (an audio timestamp) is an additive enum member, not a new card
 * shape — that is the "media later without churn" property #429 relies on.
 */
export const EVIDENCE_ANCHOR_KINDS = ["page", "visual", "unknown"] as const;

export type EvidenceAnchorKind = (typeof EVIDENCE_ANCHOR_KINDS)[number];

export const evidenceAnchorKindSchema = z.enum(EVIDENCE_ANCHOR_KINDS);

/**
 * Normalized visual region — fractions of the image's width/height in `[0, 1]`,
 * so the same anchor survives resizing and different extraction backends.
 */
export const evidenceVisualRegionSchema = z.object({
  x: z.number().min(0).max(1),
  y: z.number().min(0).max(1),
  width: z.number().min(0).max(1),
  height: z.number().min(0).max(1),
});

export type EvidenceVisualRegion = z.infer<typeof evidenceVisualRegionSchema>;

/**
 * A likely extraction confidence, never a promise. `0` is "probably wrong",
 * `1` is "verified"; an absent value is not a claim either way.
 */
export const evidenceAnchorSchema = z.object({
  kind: evidenceAnchorKindSchema,
  /** 1-based page number for `page` anchors. */
  page: z.number().int().positive().optional(),
  /** Region for `visual` anchors. */
  region: evidenceVisualRegionSchema.optional(),
  /** Extraction confidence in `[0, 1]`, when the extractor reports one. */
  confidence: z.number().min(0).max(1).optional(),
  /** An honest degraded-media note, e.g. "OCR unavailable". */
  note: z.string().min(1).max(500).optional(),
});

export type EvidenceAnchor = z.infer<typeof evidenceAnchorSchema>;

/**
 * An opaque handle the fabric can later expand into live provider data (#428).
 * The boundary itself never dereferences it; `ref` is meaningful only to the
 * named `sourceId`, and `kind` is a source-declared read shape (a document, a
 * Gmail message, an MCP tool). Raw bytes and full bodies never ride on the
 * card — this is the fingerprint that fetches them on demand.
 */
export const evidenceExpansionHandleSchema = z.object({
  /** The `ContextSource.id` that can expand this handle. */
  sourceId: z.string().min(1).max(200),
  /** Source-declared read shape — `document`, `gmail_message`, `mcp_tool`. */
  kind: z.string().min(1).max(100),
  /** Opaque reference, interpreted only by `sourceId`. */
  ref: z.string().min(1).max(1_024),
  /** Human hint for debugging, never a dereference instruction. */
  hint: z.string().min(1).max(300).optional(),
});

export type EvidenceExpansionHandle = z.infer<typeof evidenceExpansionHandleSchema>;

/**
 * The canonical evidence card. `id` is stable: the same underlying record
 * retrieved twice yields the same id, so citations, dedup, and ranking have one
 * anchor. `source` is the manifest-interoperable origin, `mediaKind` is the
 * payload modality, and the optional fields are the evidence a given card can
 * carry. The refine enforces the one honesty invariant: a card must say
 * something — a bounded `snippet`, a `note`, or both — never carry no content
 * at all.
 */
export const evidenceCardSchema = z
  .object({
    /** Stable id, reproducible across repeated retrieval of the same record. */
    id: z.string().min(1).max(512),
    source: evidenceSourceRefSchema,
    mediaKind: evidenceMediaKindSchema,
    /** Bounded text preview. Absent on a media placeholder explained by `note`. */
    snippet: z.string().min(1).max(EVIDENCE_SNIPPET_MAX_CHARS).optional(),
    /** Honest degraded/missing explanation — extraction gaps, missing state. */
    note: z.string().min(1).max(1_000).optional(),
    /** Deterministic object-state identity (#425). */
    object: evidenceObjectRefSchema.optional(),
    /** Entities the evidence is about, canonical per `kind`. */
    entities: z.array(evidenceEntityRefSchema).max(50).optional(),
    time: evidenceTimeSchema.optional(),
    authority: evidenceAuthoritySchema.optional(),
    citations: z.array(evidenceCitationSchema).max(20).optional(),
    /** Page/visual anchors for media evidence (#429). */
    anchors: z.array(evidenceAnchorSchema).max(50).optional(),
    /** Opaque live-drill-down handle (#428). */
    expansion: evidenceExpansionHandleSchema.optional(),
  })
  .refine((card) => card.snippet !== undefined || card.note !== undefined, {
    message: "an evidence card must carry a snippet, a note, or both",
    path: ["snippet"],
  });

export type EvidenceCard = z.infer<typeof evidenceCardSchema>;
