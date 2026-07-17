import { db } from "@alfred/db";
import { eventsOutbox } from "@alfred/db/schemas";
import { and, asc, eq, gt, isNotNull, lte, sql } from "drizzle-orm";
import type { EventFrame } from "../../events/types";
import { isKnownEventKind } from "../../events/types";
import { REPLAY_PAGE_SIZE, toReplayPage, type ReplayPage } from "./replay-page";

/**
 * A replay page is capped so a malicious or buggy `since=0` request cannot
 * read an unbounded history in one connection. The route closes after a full
 * page; EventSource reconnects with its final id to request the next page.
 */
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
): Promise<ReplayPage<EventFrame> & { cursor: number }> {
  if (watermark <= sinceId) return { frames: [], hasMore: false, cursor: sinceId };

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
    .limit(REPLAY_PAGE_SIZE + 1);

  const page = toReplayPage(rows);
  const cursor = Number(page.frames.at(-1)?.id ?? sinceId);
  const frames = page.frames.flatMap<EventFrame>((row) => {
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

  return { frames, hasMore: page.hasMore, cursor };
}
