import { z } from "zod";
import {
  closesOpenAsk,
  isObjectStateProvider,
  OBJECT_STATE_CATEGORIES,
  type LoopClosingStateCategory,
} from "./integration-objects";
import { objectIdentitySchema } from "./object-identity";
import { identityRefSchema } from "./user-model";

/**
 * The one evidence shape every Context Search source returns (ADR-0101). Replaces `ContextEvidence`.
 * Source-agnostic: `source.id` joins to the capability manifest, so a new source
 * is a registration, not a schema edit. A new medium is a `mediaKind` or anchor member.
 */

/** Max snippet length in characters, so a card never carries a full provider body. */
export const EVIDENCE_SNIPPET_MAX_CHARS = 2_000;

/**
 * The payload modality. One page of a document is still `document`; the page goes in a `page` anchor.
 * A media card may have no snippet if a `note` explains why.
 */
export const EVIDENCE_MEDIA_KINDS = [
  "text",
  "document",
  "image",
  "audio",
  "video",
  "unknown",
] as const;

export type EvidenceMediaKind = (typeof EVIDENCE_MEDIA_KINDS)[number];

export const evidenceMediaKindSchema = z.enum(EVIDENCE_MEDIA_KINDS);

/** How a source is backed: first-party integration, Alfred's own store, remote MCP, or undeclared. */
export const EVIDENCE_SOURCE_KINDS = ["native", "internal", "mcp", "unknown"] as const;

export type EvidenceSourceKind = (typeof EVIDENCE_SOURCE_KINDS)[number];

export const evidenceSourceKindSchema = z.enum(EVIDENCE_SOURCE_KINDS);

/** Where a card came from. `id` must equal the producing `ContextSource.id` (ADR-0101). */
export const evidenceSourceRefSchema = z.object({
  id: z.string().min(1).max(200),
  kind: evidenceSourceKindSchema,
  /** Human name for citations. An unnamed MCP source may omit it. */
  displayName: z.string().min(1).max(200).optional(),
  /** Host for grouping/citation, e.g. `github.com`. Never a name switch. */
  domain: z.string().min(1).max(253).optional(),
});

export type EvidenceSourceRef = z.infer<typeof evidenceSourceRefSchema>;

/**
 * How a card holds its object. `is`: the card is the object, found by exact key.
 * `names`: a chunk found by similarity mentions the object.
 * Only `is` gets the ranker's `exactMatch` and a 0 focus score on a miss.
 * The packer labels them apart, so a chunk that names a merged PR is not read as the PR.
 * Not `mentions`: `KeyProposalReading` already uses that word for something else.
 */
export const EVIDENCE_OBJECT_RELATIONS = ["is", "names"] as const;

export type EvidenceObjectRelation = (typeof EVIDENCE_OBJECT_RELATIONS)[number];

export const evidenceObjectRelationSchema = z.enum(EVIDENCE_OBJECT_RELATIONS);

/**
 * Object identity for object-state evidence. Never infer a missing `stateCategory` from `nativeState`.
 * `relation` has no default, so a `names` producer cannot inherit the `is` reading by accident.
 */
export const evidenceObjectRefSchema = objectIdentitySchema.extend({
  relation: evidenceObjectRelationSchema,
  stateCategory: z.enum(OBJECT_STATE_CATEGORIES).optional(),
  /** Raw provider state for display, e.g. `merged`. */
  nativeState: z.string().min(1).max(200).optional(),
  /**
   * When the object's last state change arrived. Set only on `names` cards:
   * there `time` dates the chunk, not the object. An `is` card uses `time.observedAt`.
   */
  stateDeliveredAt: z.iso.datetime({ offset: true }).optional(),
  title: z.string().min(1).max(500).optional(),
  url: z.string().min(1).max(2_048).optional(),
  /** Provider-specific locator, e.g. `owner/repo` for a GitHub PR. */
  repo: z.string().min(1).max(300).optional(),
});

export type EvidenceObjectRef = z.infer<typeof evidenceObjectRefSchema>;

/**
 * The category in which this object closes an open ask, or `null`. Uses the per-kind registry policy.
 * Unknown provider, kind, or category returns `null`: absence never closes (ADR-0048-D).
 * `failed` returns `null` because a CI failure opens a loop.
 * Cards hold stored state only, so a `live_confirmation` kind returns `null` (ADR-0103).
 */
export function evidenceObjectClosesAsk(
  object: EvidenceObjectRef,
): LoopClosingStateCategory | null {
  if (object.stateCategory === undefined) return null;

  if (!isObjectStateProvider(object.provider)) return null;

  return closesOpenAsk(object.provider, object.kind, object.stateCategory, "stored_projection");
}

/**
 * One entity the evidence is about. Extend `identityRefSchema`, do not restate it,
 * so a card entity passes the same checks as the entity id mint.
 */
export const evidenceEntityRefSchema = identityRefSchema.extend({
  display: z.string().min(1).max(300).optional(),
});

export type EvidenceEntityRef = z.infer<typeof evidenceEntityRefSchema>;

/** How current a card is. The source declares it; never infer it from a missing timestamp. */
export const EVIDENCE_FRESHNESS_VALUES = ["live", "ingested", "stale", "unknown"] as const;

export type EvidenceFreshness = (typeof EVIDENCE_FRESHNESS_VALUES)[number];

export const evidenceFreshnessSchema = z.enum(EVIDENCE_FRESHNESS_VALUES);

/** Card timestamps. A source sets only what it knows. */
export const evidenceTimeSchema = z.object({
  occurredAt: z.iso.datetime({ offset: true }).optional(),
  observedAt: z.iso.datetime({ offset: true }).optional(),
  indexedAt: z.iso.datetime({ offset: true }).optional(),
  freshness: evidenceFreshnessSchema.optional(),
});

export type EvidenceTime = z.infer<typeof evidenceTimeSchema>;

/** Source authority from the manifest. An undeclared source stays `unknown`, never `high`. */
export const EVIDENCE_AUTHORITY_LEVELS = ["high", "medium", "low", "unknown"] as const;

export type EvidenceAuthorityLevel = (typeof EVIDENCE_AUTHORITY_LEVELS)[number];

export const evidenceAuthorityLevelSchema = z.enum(EVIDENCE_AUTHORITY_LEVELS);

export const evidenceAuthoritySchema = z.object({
  level: evidenceAuthorityLevelSchema,
  label: z.string().min(1).max(200).optional(),
});

export type EvidenceAuthority = z.infer<typeof evidenceAuthoritySchema>;

/** Max citation label length in characters. */
export const EVIDENCE_CITATION_LABEL_MAX_CHARS = 300;

/** Max citation URL length. Drop a longer URL; a truncated link does not resolve. */
export const EVIDENCE_CITATION_URL_MAX_CHARS = 2_048;

/**
 * A citation the model may render as a link. Internal records have no `url`; `locator` points instead.
 * Put a page number in a `page` anchor, not here.
 */
export const evidenceCitationSchema = z.object({
  label: z.string().min(1).max(EVIDENCE_CITATION_LABEL_MAX_CHARS),
  url: z.string().min(1).max(EVIDENCE_CITATION_URL_MAX_CHARS).optional(),
  locator: z.string().min(1).max(500).optional(),
});

export type EvidenceCitation = z.infer<typeof evidenceCitationSchema>;

export const EVIDENCE_ANCHOR_KINDS = ["page", "visual", "unknown"] as const;

export type EvidenceAnchorKind = (typeof EVIDENCE_ANCHOR_KINDS)[number];

export const evidenceAnchorKindSchema = z.enum(EVIDENCE_ANCHOR_KINDS);

/** Region as fractions of image width and height, so it survives resizing. */
export const evidenceVisualRegionSchema = z.object({
  x: z.number().min(0).max(1),
  y: z.number().min(0).max(1),
  width: z.number().min(0).max(1),
  height: z.number().min(0).max(1),
});

export type EvidenceVisualRegion = z.infer<typeof evidenceVisualRegionSchema>;

/** Extraction confidence: 0 probably wrong, 1 verified. */
const evidenceAnchorConfidenceSchema = z.number().min(0).max(1).optional();

/** Degraded-media note, e.g. "OCR unavailable". */
const evidenceAnchorNoteSchema = z.string().min(1).max(500).optional();

export const evidencePageAnchorSchema = z.object({
  kind: z.literal("page"),
  /** 1-based. */
  page: z.number().int().positive(),
  confidence: evidenceAnchorConfidenceSchema,
  note: evidenceAnchorNoteSchema,
});

export const evidenceVisualAnchorSchema = z.object({
  kind: z.literal("visual"),
  region: evidenceVisualRegionSchema,
  confidence: evidenceAnchorConfidenceSchema,
  note: evidenceAnchorNoteSchema,
});

export const evidenceUnknownAnchorSchema = z.object({
  kind: z.literal("unknown"),
  confidence: evidenceAnchorConfidenceSchema,
  note: evidenceAnchorNoteSchema,
});

/** One place evidence points at. Renderers switch on `kind` exhaustively, so a new member fails typecheck. */
export const evidenceAnchorSchema = z.discriminatedUnion("kind", [
  evidencePageAnchorSchema,
  evidenceVisualAnchorSchema,
  evidenceUnknownAnchorSchema,
]);

export type EvidenceAnchor = z.infer<typeof evidenceAnchorSchema>;

/** Max expansion `kind` length, shared with the manifest's `expansionKinds`. */
export const EVIDENCE_EXPANSION_HANDLE_KIND_MAX_CHARS = 100;

/**
 * Max card `note` length. Truncate provider text to this:
 * an overlong note rejects the whole card and loses the reason it carried.
 */
export const EVIDENCE_NOTE_MAX_CHARS = 1_000;

/** Expansion kinds the built-in sources mint. MCP kinds stay open strings (ADR-0101). */
export const BUILT_IN_EXPANSION_KINDS = [
  "document",
  "memory_chunk",
  "integration_object",
  "drive_file",
] as const;

export type BuiltInExpansionKind = (typeof BUILT_IN_EXPANSION_KINDS)[number];

/** An opaque handle that `sourceId` can later expand into full provider data. */
export const evidenceExpansionHandleSchema = z.object({
  sourceId: z.string().min(1).max(200),
  /** Source-declared read shape, e.g. `document`. */
  kind: z.string().min(1).max(EVIDENCE_EXPANSION_HANDLE_KIND_MAX_CHARS),
  ref: z.string().min(1).max(1_024),
  /** Debug hint only. */
  hint: z.string().min(1).max(300).optional(),
});

export type EvidenceExpansionHandle = z.infer<typeof evidenceExpansionHandleSchema>;

/** The evidence card. The same record always gets the same `id`. A card needs a snippet or a note. */
export const evidenceCardSchema = z
  .object({
    id: z.string().min(1).max(512),
    source: evidenceSourceRefSchema,
    mediaKind: evidenceMediaKindSchema,
    snippet: z.string().min(1).max(EVIDENCE_SNIPPET_MAX_CHARS).optional(),
    /** Source-native relevance, higher is better. Compare only within one source. Never shown to the model. */
    score: z.number().finite().optional(),
    note: z.string().min(1).max(EVIDENCE_NOTE_MAX_CHARS).optional(),
    object: evidenceObjectRefSchema.optional(),
    entities: z.array(evidenceEntityRefSchema).max(50).optional(),
    time: evidenceTimeSchema.optional(),
    authority: evidenceAuthoritySchema.optional(),
    citations: z.array(evidenceCitationSchema).max(20).optional(),
    anchors: z.array(evidenceAnchorSchema).max(50).optional(),
    expansion: evidenceExpansionHandleSchema.optional(),
  })
  .refine((card) => card.snippet !== undefined || card.note !== undefined, {
    message: "an evidence card must carry a snippet, a note, or both",
    path: ["snippet"],
  });

export type EvidenceCard = z.infer<typeof evidenceCardSchema>;
