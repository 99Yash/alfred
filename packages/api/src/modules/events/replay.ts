import { db } from "@alfred/db";
import { eventsOutbox } from "@alfred/db/schemas";
import { and, asc, eq, gt, isNotNull, lte, sql } from "drizzle-orm";
import type { EventFrame } from "../../events/types";
import { isKnownEventKind } from "../../events/types";

/**
 * Hard cap so a malicious or buggy client passing `since=0` can't make us
 * stream every event the user has ever received. If a client legitimately
 * needs to backfill past this, they should sync via Replicache (the durable
 * domain state) instead.
 */
const REPLAY_LIMIT = 500;

export async function getReplayHighWatermark(userId: string): Promise<number> {
  const [row] = await db()
    .select({ max: sql<string | null>`MAX(${eventsOutbox.id})` })
    .from(eventsOutbox)
    .where(and(eq(eventsOutbox.userId, userId), isNotNull(eventsOutbox.publishedAt)));
  return row?.max ? Number(row.max) : 0;
}

export async function getEventsSince(
  userId: string,
  sinceId: number,
  watermark: number,
): Promise<EventFrame[]> {
  if (watermark <= sinceId) return [];

  const rows = await db()
    .select({
      id: eventsOutbox.id,
      kind: eventsOutbox.kind,
      payload: eventsOutbox.payload,
      createdAt: eventsOutbox.createdAt,
    })
    .from(eventsOutbox)
    .where(
      and(
        eq(eventsOutbox.userId, userId),
        gt(eventsOutbox.id, sinceId),
        lte(eventsOutbox.id, watermark),
        isNotNull(eventsOutbox.publishedAt),
      ),
    )
    .orderBy(asc(eventsOutbox.id))
    .limit(REPLAY_LIMIT + 1);

  if (rows.length > REPLAY_LIMIT) {
    console.warn(
      "[events:replay] user",
      userId,
      "hit replay cap of",
      REPLAY_LIMIT,
      "events since id",
      sinceId,
      "— truncating",
    );
    rows.length = REPLAY_LIMIT;
  }

  return rows.flatMap<EventFrame>((row) => {
    if (!isKnownEventKind(row.kind)) return [];
    return [
      {
        id: Number(row.id),
        kind: row.kind,
        payload: row.payload,
        createdAt: row.createdAt.toISOString(),
      },
    ];
  });
}
