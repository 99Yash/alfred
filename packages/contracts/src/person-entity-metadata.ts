/**
 * Typed views over the `entities.metadata` jsonb bag written by team-graph
 * capture (ADR-0059 P4a). No job title: mail headers do not carry one.
 * Here, not in `knowledge`, because the `gmail.send_draft` recipient policy reads it too.
 */
import { z } from "zod";

/** Closed set: codes persist in `entities.metadata.listEvidence`, so a retired code must fail the parse. */
export const LIST_EVIDENCE_CODES = [
  "gmail:list_id",
  "gmail:list_unsubscribe",
  "gmail:precedence:bulk",
  "gmail:precedence:list",
] as const;

export const listEvidenceCodeSchema = z.enum(LIST_EVIDENCE_CODES);

export type ListEvidenceCode = z.infer<typeof listEvidenceCodeSchema>;

/** Correspondence per `person` entity, from the user's point of view. */
const correspondenceStatsSchema = z.object({
  /** Mail from this contact. */
  inbound: z.number().int().nonnegative().default(0),
  /** Mail the user sent with this contact on `to`/`cc`. */
  outbound: z.number().int().nonnegative().default(0),
  /** Times this contact was a co-recipient on mail the user received. */
  coRecipient: z.number().int().nonnegative().default(0),
  /** ISO timestamp of the earliest message, or `null`. */
  firstSeenAt: z.string().nullable().default(null),
  /** ISO timestamp of the latest message, or `null`. */
  lastSeenAt: z.string().nullable().default(null),
});

export type CorrespondenceStats = z.infer<typeof correspondenceStatsSchema>;

/** ADR-0057 score components. Not the ADR-0067 `SignificanceComponents` in contracts. */
const significanceScoreComponentsSchema = z.object({
  frequency: z.number(),
  recency: z.number(),
  reciprocity: z.number(),
  sameOrg: z.number(),
});

export type SignificanceScoreComponents = z.infer<typeof significanceScoreComponentsSchema>;

/** The ADR-0057 scalar in `[0,1]`, stored under `metadata.significance`. */
const significanceSchema = z.object({
  score: z.number().min(0).max(1),
  components: significanceScoreComponentsSchema,
  computedAt: z.string(),
});

export type Significance = z.infer<typeof significanceSchema>;

/** A `person` entity's metadata. Every field is optional. */
const personEntityMetadataSchema = z.object({
  /** Lowercased primary address. */
  primaryAddress: z.string().optional(),
  domain: z.string().nullable().optional(),
  correspondence: correspondenceStatsSchema.optional(),
  significance: significanceSchema.optional(),
  /**
   * List-header codes from this contact's mail (#1198). Grow-only. A bad stored
   * value reads as absent, so the rest of the bag survives.
   */
  listEvidence: z.array(listEvidenceCodeSchema).optional().catch(undefined),
  /** Sticky once the user has sent mail to this contact (#1198). Overwrite scans reset `outbound`. */
  userHasWrittenTo: z.boolean().optional().catch(undefined),
});

export type PersonEntityMetadata = z.infer<typeof personEntityMetadataSchema>;

/** Lenient parse of the metadata bag. */
export function parsePersonEntityMetadata(raw: unknown): PersonEntityMetadata {
  const parsed = personEntityMetadataSchema.safeParse(raw ?? {});

  return parsed.success ? parsed.data : {};
}

/**
 * The user has sent mail to this contact. Reads the sticky flag as well as `outbound`, because an
 * overwrite scan resets `outbound`. Both come only from the user's own sent mail.
 */
export function hasUserWrittenTo(metadata: PersonEntityMetadata): boolean {
  return metadata.userHasWrittenTo === true || (metadata.correspondence?.outbound ?? 0) > 0;
}
