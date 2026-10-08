import { type SenderContext } from "@alfred/contracts";
import { db } from "@alfred/db";
import { senderPriors } from "@alfred/db/schemas";
import type { TriageCategory } from "@alfred/integrations/google";
import { and, eq, sql } from "drizzle-orm";
import type { PgUpdateSetSource } from "drizzle-orm/pg-core";
import { createRedisConnection, type BoundedRedis } from "@alfred/db/redis";

/**
 * Per-sender category histogram (ADR-0051 #2), a hint to the classifier. Postgres
 * is the truth; Redis is a read-through cache, busted on every increment.
 */

const CACHE_PREFIX = "alfred:sender-prior:";

const CACHE_TTL_SECONDS = 60 * 60;

/** The read shape only; the name collides with the full DB row on purpose. */
export type SenderPrior = Pick<typeof senderPriors.$inferSelect, "categoryCounts" | "lastCategory">;

// ---------------------------------------------------------------------------
// Pure helpers (no IO) — unit-tested directly
// ---------------------------------------------------------------------------

/**
 * Prior key, or null to skip priors. Null for people: their category is per
 * message. Bots key on `service:<botSlug>` because GitHub apps share one envelope.
 * Unknown senders get null: `team@` or `info@` may be staffed.
 */
export function senderKeyFor(
  senderContext: Pick<SenderContext, "effectiveAuthor" | "botSlug">,
  senderAddress: string | null,
): string | null {
  if (senderContext.effectiveAuthor === "person") return null;

  if (senderContext.botSlug) return `service:${senderContext.botSlug}`;

  if (senderContext.effectiveAuthor !== "service") return null;

  if (senderAddress) return senderAddress.toLowerCase();

  return null;
}

export interface SenderPriorWriteKeyArgs {
  senderContext: Pick<SenderContext, "effectiveAuthor" | "botSlug">;
  senderAddress: string | null;
  isSent: boolean;
  /** `"fallback"` never teaches. */
  model: string;
}

/** Learn only from real classifications of received bulk/service mail. */
export function senderPriorWriteKeyFor(args: SenderPriorWriteKeyArgs): string | null {
  if (args.isSent) return null;

  if (args.model === "fallback") return null;

  return senderKeyFor(args.senderContext, args.senderAddress);
}

// ---------------------------------------------------------------------------
// Redis read-through cache
// ---------------------------------------------------------------------------

let redis: BoundedRedis | undefined;

function getRedis(): BoundedRedis {
  // "fail-fast" is safe only because Postgres backs every read. It also rejects the
  // first command of each process, so the first email reads Postgres. Intended.
  if (!redis) redis = createRedisConnection("fail-fast");

  return redis;
}

function cacheKey(userId: string, senderKey: string): string {
  return `${CACHE_PREFIX}${userId}:${senderKey}`;
}

// ---------------------------------------------------------------------------
// Store
// ---------------------------------------------------------------------------

async function loadSenderPriorFromDb(
  userId: string,
  senderKey: string,
): Promise<SenderPrior | null> {
  const rows = await db()
    .select({
      categoryCounts: senderPriors.categoryCounts,
      lastCategory: senderPriors.lastCategory,
    })
    .from(senderPriors)
    .where(and(eq(senderPriors.userId, userId), eq(senderPriors.senderKey, senderKey)))
    .limit(1);

  const row = rows[0];

  if (!row) return null;

  return { categoryCounts: row.categoryCounts ?? {}, lastCategory: row.lastCategory };
}

/** Null for a sender never classified. A Redis blip falls back to Postgres. */
export async function getSenderPrior(
  userId: string,
  senderKey: string,
): Promise<SenderPrior | null> {
  const key = cacheKey(userId, senderKey);

  try {
    const cached = await getRedis().get(key);

    if (cached !== null) {
      // "null" caches a known-absent sender.
      // SAFETY: only this module writes the key, as a stringified SenderPrior or
      // "null"; corrupt content throws into the miss path.
      return cached === "null" ? null : (JSON.parse(cached) as SenderPrior);
    }
  } catch {}

  const fromDb = await loadSenderPriorFromDb(userId, senderKey);

  try {
    await getRedis().set(key, fromDb ? JSON.stringify(fromDb) : "null", "EX", CACHE_TTL_SECONDS);
  } catch {}

  return fromDb;
}

export interface IncrementSenderPriorArgs {
  userId: string;
  senderKey: string;
  category: TriageCategory;
  displayName?: string | null;
}

/**
 * Add one vote in SQL, so concurrent runs do not clobber each other. Callers
 * must skip people and sent mail.
 */
export async function incrementSenderPrior(args: IncrementSenderPriorArgs): Promise<void> {
  const now = new Date();

  const updateSet: PgUpdateSetSource<typeof senderPriors> = {
    categoryCounts: sql`jsonb_set(
      ${senderPriors.categoryCounts},
      ARRAY[${args.category}],
      to_jsonb(COALESCE((${senderPriors.categoryCounts} ->> ${args.category})::int, 0) + 1)
    )`,
    lastCategory: args.category,
    lastSeenAt: now,
    updatedAt: now,
  };

  // Never null out a name we already have.
  if (args.displayName) updateSet.displayName = args.displayName;

  await db()
    .insert(senderPriors)
    .values({
      userId: args.userId,
      senderKey: args.senderKey,
      categoryCounts: { [args.category]: 1 },
      lastCategory: args.category,
      displayName: args.displayName ?? null,
      lastSeenAt: now,
    })
    .onConflictDoUpdate({
      target: [senderPriors.userId, senderPriors.senderKey],
      set: updateSet,
    });

  try {
    await getRedis().del(cacheKey(args.userId, args.senderKey));
  } catch {
    // The 1h TTL covers a missed delete.
  }
}
