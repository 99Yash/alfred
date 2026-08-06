/**
 * Typed views over the free-form `entities.metadata` jsonb bag that passive
 * team-graph capture (ADR-0059 P4a) writes onto `person` / `organization`
 * rows. The column is jsonb (`upsertEntity` merges keys last-writes-wins), so
 * these schemas are the single source of truth for the *shape* the extractor
 * writes and the significance pass + Sender-relationship resolver read.
 *
 * Designation (job title) is deliberately absent: it is not derivable from
 * mail headers and waits on web-search enrichment (P4b). The resolver degrades
 * to `theirDesignation: null` until then.
 */
import { z } from "zod";

/**
 * Correspondence aggregate per `person` entity, accumulated over the user's
 * ingested mail. Direction is from the *user's* perspective.
 */
export const correspondenceStatsSchema = z.object({
  /** Mail received FROM this contact (they were the `from`). */
  inbound: z.number().int().nonnegative().default(0),
  /** Mail the user SENT with this contact on `to`/`cc`. */
  outbound: z.number().int().nonnegative().default(0),
  /** Times this contact rode as a co-recipient on mail the *user* received. */
  coRecipient: z.number().int().nonnegative().default(0),
  /** ISO timestamp of the earliest message touching this contact (`null` if unknown). */
  firstSeenAt: z.string().nullable().default(null),
  /** ISO timestamp of the latest message touching this contact (`null` if unknown). */
  lastSeenAt: z.string().nullable().default(null),
});
export type CorrespondenceStats = z.infer<typeof correspondenceStatsSchema>;

/**
 * Components of the scalar significance signal (ADR-0057) — kept for
 * tuning/explainability. Distinct from `@alfred/contracts`'s ADR-0067
 * `SignificanceComponents` (a different, multi-source decomposition); named
 * apart so the two never collide through the `@alfred/api/backend` barrel.
 */
export const significanceScoreComponentsSchema = z.object({
  frequency: z.number(),
  recency: z.number(),
  reciprocity: z.number(),
  sameOrg: z.number(),
});
export type SignificanceScoreComponents = z.infer<typeof significanceScoreComponentsSchema>;

/**
 * The scalar significance signal (ADR-0057) — one number in `[0,1]`, the
 * shared "who matters" primitive. Stored under `metadata.significance`.
 */
export const significanceSchema = z.object({
  score: z.number().min(0).max(1),
  components: significanceScoreComponentsSchema,
  /** ISO timestamp of the pass that produced this score. */
  computedAt: z.string(),
});
export type Significance = z.infer<typeof significanceSchema>;

/** Typed view of a `person` entity's metadata bag. All fields optional — the bag is additive. */
export const personEntityMetadataSchema = z.object({
  /** Lowercased primary `local@domain` for the contact. */
  primaryAddress: z.string().optional(),
  /** Lowercased domain portion of {@link personEntityMetadataSchema.shape.primaryAddress}. */
  domain: z.string().nullable().optional(),
  correspondence: correspondenceStatsSchema.optional(),
  significance: significanceSchema.optional(),
});
export type PersonEntityMetadata = z.infer<typeof personEntityMetadataSchema>;

/** Parse a raw jsonb metadata value into the typed person-entity view (lenient — unknown keys preserved separately). */
export function parsePersonEntityMetadata(raw: unknown): PersonEntityMetadata {
  const parsed = personEntityMetadataSchema.safeParse(raw ?? {});
  return parsed.success ? parsed.data : {};
}
