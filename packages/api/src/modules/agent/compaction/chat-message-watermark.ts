import type { SQLWrapper } from "drizzle-orm";
import { and, eq, gt, lt, lte, or, sql } from "drizzle-orm";

export interface ChatMessageWatermark {
  createdAt: Date;
  messageId: string;
}

export function chatMessageWatermark(row: { createdAt: Date; id: string }): ChatMessageWatermark {
  return { createdAt: row.createdAt, messageId: row.id };
}

export function nullableChatMessageWatermark(
  createdAt: Date | null | undefined,
  messageId: string | null | undefined,
): ChatMessageWatermark | null {
  if (!createdAt || !messageId) return null;
  return { createdAt, messageId };
}

export function compareChatMessageWatermarks(
  left: ChatMessageWatermark,
  right: ChatMessageWatermark,
): number {
  const timestampDifference = left.createdAt.getTime() - right.createdAt.getTime();
  if (timestampDifference !== 0) return timestampDifference;
  if (left.messageId === right.messageId) return 0;
  return left.messageId < right.messageId ? -1 : 1;
}

/**
 * Postgres timestamps can retain microseconds that JavaScript Date discards.
 * Compare message-stream cursors at the driver's millisecond precision so the
 * boundary row is neither omitted nor selected again after a round trip.
 */
function millisecondTimestamp(column: SQLWrapper) {
  return sql<Date>`date_trunc('milliseconds', ${column})`;
}

export function afterChatMessageWatermark(
  createdAtColumn: SQLWrapper,
  messageIdColumn: SQLWrapper,
  watermark: ChatMessageWatermark,
) {
  const createdAt = millisecondTimestamp(createdAtColumn);
  return or(
    gt(createdAt, watermark.createdAt),
    and(eq(createdAt, watermark.createdAt), gt(messageIdColumn, watermark.messageId)),
  );
}

export function throughChatMessageWatermark(
  createdAtColumn: SQLWrapper,
  messageIdColumn: SQLWrapper,
  watermark: ChatMessageWatermark,
) {
  const createdAt = millisecondTimestamp(createdAtColumn);
  return or(
    lt(createdAt, watermark.createdAt),
    and(eq(createdAt, watermark.createdAt), lte(messageIdColumn, watermark.messageId)),
  );
}
