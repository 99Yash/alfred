import type { IanaTimezone, InboundEventSource } from "@alfred/contracts";
import { sha256 } from "@alfred/corpus";
import { db, type DbTransaction } from "@alfred/db";
import { documents, eventReceipts, type Document, type EventReceipt } from "@alfred/db/schemas";
import { and, count, eq, gte, lt, sql, type SQL } from "drizzle-orm";
import { inZone } from "@alfred/assistant/time";
import { INBOUND_SOURCES } from "../ingress";
import { INBOUND_DAILY_EMBED_CAP, INBOUND_DAILY_EMBED_CAP_REASON } from "../receipt-corpus-policy";

/**
 * The corpus document of one receipt is keyed `(userId, source = the event
 * source, sourceId = the receipt id)`. This file is the one place that key is
 * spelled: the writer below inserts under it, {@link receiptDocumentJoin} is
 * the same key as a SQL join for the inventory and the backfill, and
 * {@link readReceiptDocument} reads it back for a run's `<trigger_event>`.
 * A re-key of the document changes these three and nothing else.
 */
export function receiptDocumentKey(receipt: {
  id: string;
  userId: string;
  provider: InboundEventSource;
}): Pick<Document, "userId" | "source" | "sourceId"> {
  return { userId: receipt.userId, source: receipt.provider, sourceId: receipt.id };
}

/** {@link receiptDocumentKey} as the join from an `eventReceipts` row to its document. */
export function receiptDocumentJoin(): SQL | undefined {
  return and(
    eq(documents.userId, eventReceipts.userId),
    eq(documents.source, eventReceipts.provider),
    eq(documents.sourceId, eventReceipts.id),
  );
}

/** The display fields of a receipt's document. `raw` is the stored payload and is never selected. */
export type ReceiptDocument = Pick<
  Document,
  "title" | "content" | "url" | "authoredAt" | "metadata"
>;

/** The document the receive path wrote for one receipt, or `null` when none exists. */
export async function readReceiptDocument(receipt: {
  id: string;
  userId: string;
  provider: InboundEventSource;
}): Promise<ReceiptDocument | null> {
  const key = receiptDocumentKey(receipt);
  const rows = await db()
    .select({
      title: documents.title,
      content: documents.content,
      url: documents.url,
      authoredAt: documents.authoredAt,
      metadata: documents.metadata,
    })
    .from(documents)
    .where(
      and(
        eq(documents.userId, key.userId),
        eq(documents.source, key.source),
        eq(documents.sourceId, key.sourceId),
      ),
    )
    .limit(1);
  return rows[0] ?? null;
}

/**
 * Called for a new receipt or a stored receipt without a document. The receipt's
 * unique key proves document identity; rollback preserves the pair on failure.
 * The per-user/source lock serializes admission across concurrent deliveries.
 * No provider or embedding call runs on this path; the existing sweep indexes it.
 */
export async function writeReceiptDocument(
  tx: DbTransaction,
  receipt: Pick<EventReceipt, "id" | "userId" | "payload" | "deliveredAt"> & {
    provider: InboundEventSource;
    kind: string;
    accountId: string;
  },
  timezone: IanaTimezone,
): Promise<void> {
  const description = INBOUND_SOURCES[receipt.provider].describe(receipt.kind, receipt.payload);
  await tx.execute(
    sql`select pg_advisory_xact_lock(hashtextextended(${`receipt-corpus:${receipt.userId}:${receipt.provider}`}, 0))`,
  );
  const admittedAt = new Date();
  const { start, end } = inZone(timezone).dayBounds(admittedAt);
  const [usage] = await tx
    .select({ count: count() })
    .from(documents)
    .where(
      and(
        eq(documents.userId, receipt.userId),
        eq(documents.source, receipt.provider),
        gte(documents.ingestedAt, start),
        lt(documents.ingestedAt, end),
      ),
    );
  const capped = (usage?.count ?? 0) >= INBOUND_DAILY_EMBED_CAP;
  await tx
    .insert(documents)
    .values({
      ...receiptDocumentKey(receipt),
      accountId: receipt.accountId,
      title: description.title,
      content: description.body,
      contentHash: sha256(description.body),
      raw: receipt.payload,
      url: description.url,
      authoredAt: receipt.deliveredAt,
      ingestedAt: admittedAt,
      metadata: { kind: receipt.kind, summary: description.summary },
      ...(capped
        ? { embedFailedAt: admittedAt, lastEmbedError: INBOUND_DAILY_EMBED_CAP_REASON }
        : {}),
    })
    .onConflictDoNothing({ target: [documents.userId, documents.source, documents.sourceId] });
}
