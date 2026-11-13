import type { InboundEventSource, RawReceiptInventory } from "@alfred/contracts";
import { db } from "@alfred/db";
import { documents, eventReceipts } from "@alfred/db/schemas";
import { receiptDocumentJoin } from "./ingestion/receipt-document";
import { INBOUND_DAILY_EMBED_CAP, INBOUND_DAILY_EMBED_CAP_REASON } from "./receipt-corpus-policy";
import { and, count, desc, eq, isNotNull, max } from "drizzle-orm";

/**
 * Raw kinds one event source has sent the user, with count and last arrival, newest first.
 * Scoped by `user_id` and `provider`, not by credential: a Disconnect keeps the receipts with
 * `credential_id` NULL, and a reconnect makes a new credential row (migration 0170).
 */
function rawKindGroups(userId: string, source: InboundEventSource) {
  const lastSeenAt = max(eventReceipts.deliveredAt);

  return db()
    .select({ rawKind: eventReceipts.rawKind, count: count(), lastSeenAt })
    .from(eventReceipts)
    .where(
      and(
        eq(eventReceipts.userId, userId),
        eq(eventReceipts.provider, source),
        isNotNull(eventReceipts.rawKind),
      ),
    )
    .groupBy(eventReceipts.rawKind)
    .orderBy(desc(lastSeenAt));
}

/**
 * Raw kinds for one event source's integration detail page (ADR-0097 item 9). It lists every
 * stored receipt, so it still shows the kinds after a Disconnect and after a reconnect.
 */
export async function readRawReceiptInventory(
  userId: string,
  source: InboundEventSource,
): Promise<RawReceiptInventory> {
  const rows = await rawKindGroups(userId, source);

  const [capped] = await db()
    .select({ count: count() })
    .from(documents)
    .innerJoin(eventReceipts, receiptDocumentJoin())
    .where(
      and(
        eq(documents.userId, userId),
        eq(eventReceipts.provider, source),
        eq(documents.lastEmbedError, INBOUND_DAILY_EMBED_CAP_REASON),
        isNotNull(documents.embedFailedAt),
      ),
    );

  return {
    embedding: { dailyCap: INBOUND_DAILY_EMBED_CAP, cappedCount: capped?.count ?? 0 },
    kinds: rows.flatMap((row) =>
      // `IS NOT NULL` proves both; the type cannot see it.
      row.rawKind && row.lastSeenAt
        ? [{ kind: row.rawKind, count: row.count, lastSeenAt: row.lastSeenAt.toISOString() }]
        : [],
    ),
  };
}

const SEEN_RAW_KINDS_LIMIT = 100;

/** Kinds one event source has sent, so authoring can refuse a raw trigger on an unseen kind (#990). */
export async function seenRawKinds(userId: string, source: InboundEventSource): Promise<string[]> {
  const rows = await rawKindGroups(userId, source).limit(SEEN_RAW_KINDS_LIMIT);

  // `IS NOT NULL` proves it; the type cannot see it.
  return rows.flatMap((row) => (row.rawKind ? [row.rawKind] : []));
}
