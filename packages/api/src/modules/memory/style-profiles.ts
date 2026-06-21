import { db } from "@alfred/db";
import { styleProfiles, type StyleProfile } from "@alfred/db/schemas";
import { and, desc, eq, inArray, isNull, or, sql } from "drizzle-orm";
import { z } from "zod";
import {
  type StyleAudienceBucket,
  type StyleChannel,
  styleAudienceBucketSchema,
  styleChannelSchema,
} from "./types";

/**
 * Style-profile primitives are intentionally minimal in m8a — table
 * CRUD only. ADR-0013's full lifecycle (lazy materialization,
 * audience-bucket inference from `user_facts`, regeneration on source
 * deletion) lands when something actually drafts on the user's behalf
 * (m9 reply drafting, ADR-0025 #5 OFF-by-default).
 */

const channelSchema = styleChannelSchema;
const audienceBucketSchema = styleAudienceBucketSchema;
const styleProfileStatusSchema = z.enum(["draft", "active", "superseded"]);
const stringArraySchema = z.array(z.string());
const unknownArraySchema = z.array(z.unknown());

export const upsertStyleProfileArgsSchema = z.object({
  userId: z.string().min(1),
  channel: channelSchema,
  audienceBucket: audienceBucketSchema,
  recipientId: z.string().nullable().optional(),
  profileDoc: z.string().min(1).max(20_000),
  examples: z.array(z.unknown()).optional(),
  sourceMsgIds: z.array(z.string()).optional(),
  generatedFromCount: z.number().int().nonnegative().optional(),
  confidence: z.number().min(0).max(1).optional(),
  status: styleProfileStatusSchema.optional(),
});
export type UpsertStyleProfileArgs = z.infer<typeof upsertStyleProfileArgsSchema>;

/**
 * Like the DB row, but with the parsed enum/jsonb columns narrowed. Every other
 * column tracks `StyleProfile` ($inferSelect) automatically; lifecycle dates and
 * `supersededById` are intentionally excluded (not part of the read shape). Only
 * the columns `rowToProfile` transforms are restated.
 */
export type StyleProfileRow = Omit<
  StyleProfile,
  | "channel"
  | "audienceBucket"
  | "examples"
  | "sourceMsgIds"
  | "status"
  | "supersededById"
  | "createdAt"
  | "updatedAt"
> & {
  channel: StyleChannel;
  audienceBucket: StyleAudienceBucket;
  examples: unknown[];
  sourceMsgIds: string[];
  status: z.infer<typeof styleProfileStatusSchema>;
};

function rowToProfile(r: StyleProfile): StyleProfileRow {
  return {
    ...r,
    channel: styleChannelSchema.parse(r.channel),
    audienceBucket: styleAudienceBucketSchema.parse(r.audienceBucket),
    status: styleProfileStatusSchema.parse(r.status),
    examples: unknownArraySchema.parse(r.examples ?? []),
    sourceMsgIds: stringArraySchema.parse(r.sourceMsgIds ?? []),
  };
}

/** Insert or replace a profile keyed by (user, channel, audience_bucket, recipient_id). */
export async function upsertStyleProfile(args: UpsertStyleProfileArgs): Promise<StyleProfileRow> {
  const parsed = upsertStyleProfileArgsSchema.parse(args);
  const status = parsed.status ?? "draft";

  // recipient_id NULL participates in the unique index as DISTINCT — so
  // drizzle's ON CONFLICT can target the unique tuple including NULL.
  // Use a guarded upsert: if a row with the same tuple exists, update.
  return await db().transaction(async (tx) => {
    const where =
      parsed.recipientId == null
        ? and(
            eq(styleProfiles.userId, parsed.userId),
            eq(styleProfiles.channel, parsed.channel),
            eq(styleProfiles.audienceBucket, parsed.audienceBucket),
            isNull(styleProfiles.recipientId),
          )
        : and(
            eq(styleProfiles.userId, parsed.userId),
            eq(styleProfiles.channel, parsed.channel),
            eq(styleProfiles.audienceBucket, parsed.audienceBucket),
            eq(styleProfiles.recipientId, parsed.recipientId),
          );

    const [existing] = await tx.select().from(styleProfiles).where(where).limit(1);
    if (!existing) {
      const [row] = await tx
        .insert(styleProfiles)
        .values({
          userId: parsed.userId,
          channel: parsed.channel,
          audienceBucket: parsed.audienceBucket,
          recipientId: parsed.recipientId ?? null,
          profileDoc: parsed.profileDoc,
          examples: parsed.examples ?? [],
          sourceMsgIds: parsed.sourceMsgIds ?? [],
          generatedAt: new Date(),
          generatedFromCount: parsed.generatedFromCount ?? 0,
          confidence: parsed.confidence ?? 0,
          status,
        })
        .returning();
      if (!row) throw new Error("[memory.style-profiles] insert returned no row");
      return rowToProfile(row);
    }

    const [row] = await tx
      .update(styleProfiles)
      .set({
        profileDoc: parsed.profileDoc,
        examples: parsed.examples ?? existing.examples,
        sourceMsgIds: parsed.sourceMsgIds ?? existing.sourceMsgIds,
        generatedAt: new Date(),
        generatedFromCount: parsed.generatedFromCount ?? existing.generatedFromCount,
        confidence: parsed.confidence ?? existing.confidence,
        status,
        rowVersion: sql`${styleProfiles.rowVersion} + 1`,
      })
      .where(eq(styleProfiles.id, existing.id))
      .returning();
    if (!row) throw new Error("[memory.style-profiles] update returned no row");
    return rowToProfile(row);
  });
}

/**
 * Most-specific applicable profile (ADR-0013 lookup precedence):
 *
 *   1. recipient-level for `recipientId`
 *   2. audience_bucket-level for `audienceBucket`
 *   3. channel-generic ('generic' bucket, NULL recipient)
 *
 * Only `active` profiles are considered; `draft` + `superseded` are skipped.
 */
export async function getStyleProfile(
  userId: string,
  channel: StyleChannel,
  audienceBucket: StyleAudienceBucket,
  recipientId?: string | null,
): Promise<StyleProfileRow | null> {
  // Recipient scoping: only a recipient-level row for *this* recipient (or a
  // recipient-agnostic row, NULL recipientId) may apply. Without this, a row
  // authored for a different recipient in the same audience bucket leaks into
  // the candidate set and can tie/beat the correct bucket-level generic row.
  const recipientScope =
    recipientId != null
      ? or(isNull(styleProfiles.recipientId), eq(styleProfiles.recipientId, recipientId))
      : isNull(styleProfiles.recipientId);

  const candidates = await db()
    .select()
    .from(styleProfiles)
    .where(
      and(
        eq(styleProfiles.userId, userId),
        eq(styleProfiles.channel, channel),
        eq(styleProfiles.status, "active"),
        inArray(styleProfiles.audienceBucket, [audienceBucket, "generic"]),
        recipientScope,
      ),
    )
    .orderBy(desc(styleProfiles.generatedFromCount));

  // Sort by specificity manually since SQL ORDER BY across two nullable
  // dimensions is awkward to express. The WHERE above guarantees every
  // candidate's recipientId is either NULL or === recipientId, so the only
  // distinctions left are: exact-recipient match, exact-bucket match, generic.
  const score = (r: StyleProfile) => {
    let s = 0;
    if (r.recipientId != null && r.recipientId === recipientId) s += 4;
    if (r.audienceBucket === audienceBucket && audienceBucket !== "generic") s += 2;
    return s;
  };
  candidates.sort((a, b) => score(b) - score(a));
  const top = candidates[0];
  return top ? rowToProfile(top) : null;
}
