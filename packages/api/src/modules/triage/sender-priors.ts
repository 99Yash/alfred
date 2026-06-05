import { type SenderContext } from "@alfred/contracts";
import { db } from "@alfred/db";
import { senderPriors } from "@alfred/db/schemas";
import type { TriageCategory } from "@alfred/integrations/google";
import { and, eq, sql } from "drizzle-orm";
import type IORedis from "ioredis";
import { createCacheRedisConnection } from "../../queue/connection";

/**
 * Sender priors store (ADR-0051 #2): a per-sender category histogram that is a
 * *fed signal* to the always-on cheap classifier, never a model bypass.
 *
 * Postgres is the source of truth; Redis is a read-through cache busted on
 * every increment. Because the model runs (and therefore increments) on every
 * email, the cache is mostly a within-burst optimization — but it keeps the
 * Phase-3 read off the per-email DB path. A Redis key is used instead of an
 * in-process Map (a Map would be stale the instant the same run increments).
 * The cache connection is fail-fast ({@link createCacheRedisConnection}): an
 * outage rejects immediately and we fall through to Postgres, so the cache is
 * never a correctness or availability dependency of the classify path.
 */

const CACHE_PREFIX = "alfred:sender-prior:";
const CACHE_TTL_SECONDS = 60 * 60; // 1h — increments bust it well before this

export interface SenderPrior {
  /** Raw category histogram. Empty object for a sender we've never classified. */
  categoryCounts: Record<string, number>;
  lastCategory: string | null;
}

// ---------------------------------------------------------------------------
// Pure helpers (no IO) — unit-tested directly
// ---------------------------------------------------------------------------

/**
 * Compute the prior key for a sender, or `null` to skip priors entirely.
 *
 * Rules (ADR-0051 #2):
 *  - Human senders (`effectiveAuthor: 'person'`) → null. A person's category
 *    is per-message; caching it would actively mis-tag (alt (f)).
 *  - Recognized bots → `service:<botSlug>` (all GitHub apps share
 *    `noreply@github.com`, so the envelope address can't distinguish them).
 *  - Service senders → the exact lowercased address.
 *  - Unknown/ambiguous senders → null. Ambiguous role mailboxes (`team@`,
 *    `info@`, etc.) can be human-staffed and should not seed priors.
 *  - No usable address → null.
 *
 * NEVER call for the user's own sent mail — guard on `metadata.isSent` at the
 * call site; you are not a sender to cache.
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
  /** Sent mail is context/search material, never a received sender to learn. */
  isSent: boolean;
  /** Concrete model id used for the persisted triage row. `"fallback"` is non-learnable. */
  model: string;
}

/**
 * Central write policy for sender-prior learning. Priors learn only from
 * successful Alfred classifications of received bulk/service mail.
 */
export function senderPriorWriteKeyFor(args: SenderPriorWriteKeyArgs): string | null {
  if (args.isSent) return null;
  if (args.model === "fallback") return null;
  return senderKeyFor(args.senderContext, args.senderAddress);
}

// ---------------------------------------------------------------------------
// Redis read-through cache
// ---------------------------------------------------------------------------

let redis: IORedis | undefined;
function getRedis(): IORedis {
  // Fail-fast cache connection: a Redis outage must degrade to the Postgres
  // read, never hang the per-email triage path. The BullMQ connection's
  // offline-queue-forever behavior would otherwise stall every classify on the
  // cache read under an outage (the try/catch can only rescue a rejection).
  if (!redis) redis = createCacheRedisConnection();
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

/**
 * Read a sender's histogram. Redis read-through over Postgres. Returns `null`
 * for a sender we've never classified. Redis blips fall back to Postgres —
 * the cache is best-effort, never a correctness dependency.
 */
export async function getSenderPrior(
  userId: string,
  senderKey: string,
): Promise<SenderPrior | null> {
  const key = cacheKey(userId, senderKey);
  try {
    const cached = await getRedis().get(key);
    if (cached !== null) {
      // Sentinel for a known-absent sender so we don't re-hit PG every email
      // for a brand-new bulk sender mid-burst.
      return cached === "null" ? null : (JSON.parse(cached) as SenderPrior);
    }
  } catch {
    // fall through to DB
  }

  const fromDb = await loadSenderPriorFromDb(userId, senderKey);
  try {
    await getRedis().set(key, fromDb ? JSON.stringify(fromDb) : "null", "EX", CACHE_TTL_SECONDS);
  } catch {
    // best-effort cache write
  }
  return fromDb;
}

export interface IncrementSenderPriorArgs {
  userId: string;
  senderKey: string;
  category: TriageCategory;
  /** Latest `From:` display name, if any — stored for debugging/UI. */
  displayName?: string | null;
}

/**
 * Increment a sender's histogram by one for `category` and bump
 * `last_category`/`last_seen_at`. Postgres-side jsonb increment so concurrent
 * triage runs on the same sender don't clobber each other (read-modify-write
 * in app code would). Busts the Redis entry afterward.
 *
 * The caller is responsible for the skip rules — never call with a key for a
 * human sender (use {@link senderKeyFor}) or for sent mail.
 */
export async function incrementSenderPrior(args: IncrementSenderPriorArgs): Promise<void> {
  const now = new Date();
  const updateSet: Record<string, unknown> = {
    categoryCounts: sql`jsonb_set(
      ${senderPriors.categoryCounts},
      ARRAY[${args.category}],
      to_jsonb(COALESCE((${senderPriors.categoryCounts} ->> ${args.category})::int, 0) + 1)
    )`,
    lastCategory: args.category,
    lastSeenAt: now,
    updatedAt: now,
  };
  // Only overwrite displayName when we actually have one — don't null out a
  // previously-captured name because this message lacked a display name.
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
    // best-effort bust; the 1h TTL backstops a missed delete
  }
}
