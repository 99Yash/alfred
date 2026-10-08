import { db } from "@alfred/db";
import {
  styleProfileInsertSchema,
  styleProfiles,
  type NewStyleProfile,
  type StyleProfile,
} from "@alfred/db/schemas";
import { and, desc, eq, inArray, isNull, or, sql } from "drizzle-orm";
import { z } from "zod";

/** `style_profiles.channel` and `audience_bucket` values (ADR-0013). The unions derive from the tuples. */
export const STYLE_CHANNELS = [
  "gmail",
  "imessage",
  "slack",
  "doc",
  "code_review",
  "twitter",
  "generic",
] as const;

export const styleChannelSchema = z.enum(STYLE_CHANNELS);

export type StyleChannel = (typeof STYLE_CHANNELS)[number];

export const STYLE_AUDIENCE_BUCKETS = [
  "family",
  "friend",
  "peer",
  "manager",
  "customer",
  "vendor",
  "public",
  "generic",
] as const;

export const styleAudienceBucketSchema = z.enum(STYLE_AUDIENCE_BUCKETS);

export type StyleAudienceBucket = (typeof STYLE_AUDIENCE_BUCKETS)[number];

const channelSchema = styleChannelSchema;

const audienceBucketSchema = styleAudienceBucketSchema;

const styleProfileStatusSchema = z.enum(["draft", "active", "superseded"]);

const stringArraySchema = z.array(z.string());

const unknownArraySchema = z.array(z.unknown());

export const upsertStyleProfileArgsSchema = styleProfileInsertSchema
  .pick({
    userId: true,
    channel: true,
    audienceBucket: true,
    recipientId: true,
    profileDoc: true,
    examples: true,
    sourceMsgIds: true,
    generatedFromCount: true,
    confidence: true,
    status: true,
  })
  .extend({
    userId: z.string().min(1),
    channel: channelSchema,
    audienceBucket: audienceBucketSchema,
    profileDoc: z.string().min(1).max(20_000),
    examples: z.array(z.json()).optional(),
    sourceMsgIds: z.array(z.string()).optional(),
    generatedFromCount: z.number().int().nonnegative().optional(),
    confidence: z.number().min(0).max(1).optional(),
    status: styleProfileStatusSchema.optional(),
  }) satisfies z.ZodType<
  Pick<
    NewStyleProfile,
    | "userId"
    | "channel"
    | "audienceBucket"
    | "recipientId"
    | "profileDoc"
    | "examples"
    | "sourceMsgIds"
    | "generatedFromCount"
    | "confidence"
    | "status"
  >
>;

export type UpsertStyleProfileArgs = z.infer<typeof upsertStyleProfileArgsSchema>;

/** `StyleProfile` with parsed columns narrowed, minus lifecycle dates and `supersededById`. */
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

/** Insert or replace by (user, channel, audience_bucket, recipient_id). */
export async function upsertStyleProfile(args: UpsertStyleProfileArgs): Promise<StyleProfileRow> {
  const parsed = upsertStyleProfileArgsSchema.parse(args);
  const status = parsed.status ?? "draft";

  // A NULL recipient_id is distinct in the unique index, so ON CONFLICT cannot catch it. Check, then update.
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
 * The most specific active profile (ADR-0013): recipient, then audience bucket,
 * then channel generic.
 */
export async function getStyleProfile(
  userId: string,
  channel: StyleChannel,
  audienceBucket: StyleAudienceBucket,
  recipientId?: string | null,
): Promise<StyleProfileRow | null> {
  // Only rows for this recipient or for no recipient, so another recipient's row cannot win.
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

  // Rank in code: every candidate's recipientId is NULL or this recipient.
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
