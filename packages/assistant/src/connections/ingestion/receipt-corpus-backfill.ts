import type { InboundEventSource } from "@alfred/contracts";
import { db } from "@alfred/db";
import { documents, eventReceipts, integrationCredentials } from "@alfred/db/schemas";
import { and, asc, count, eq, isNotNull, notExists } from "drizzle-orm";
import {
  prepareReceiptProjection,
  receiptDocumentJoin,
  writeReceiptDocument,
} from "./receipt-document";
import { logger } from "@alfred/logging";

/** Rows per call. The `gmail.embed_sweep` tick calls once; the committed script loops. */
const BACKFILL_BATCH_SIZE = 50;

/** A receipt that still holds a body, and no document. */
function bodyWithoutDocument(source: InboundEventSource) {
  return and(
    eq(eventReceipts.provider, source),
    isNotNull(eventReceipts.payload),
    notExists(db().select({ id: documents.id }).from(documents).where(receiptDocumentJoin())),
  );
}

/**
 * The receipts of a source whose body is only on the receipt. The `payload` column can be dropped
 * when this is 0 for every source.
 */
export async function countReceiptBodiesWithoutDocument(
  source: InboundEventSource,
): Promise<number> {
  const [row] = await db()
    .select({ count: count() })
    .from(eventReceipts)
    .where(bodyWithoutDocument(source));

  return row?.count ?? 0;
}

/**
 * Project receipts that have a body but no corpus document, in a bounded batch, and return the
 * number written. Only old receipts can match: the receive path writes the document in the
 * receipt's transaction and no longer stores the body on the receipt. This backfill moves their
 * bodies to `documents.raw`, the one copy (stores.md), so the `payload` column can go.
 *
 * - `payload IS NOT NULL`: a receipt with no body would give a hollow document.
 * - Left join: a disconnect sets `credential_id` to NULL (migration 0170). The document then has no
 *   `account_id`, but the body is kept.
 *
 * Catch per row: one bad row must not fail the whole `gmail.embed_sweep` `Promise.all`. A skipped
 * row is retried next tick.
 */
export async function backfillReceiptDocuments(source: InboundEventSource): Promise<number> {
  const rows = await db()
    .select({ receipt: eventReceipts, accountId: integrationCredentials.accountId })
    .from(eventReceipts)
    .leftJoin(integrationCredentials, eq(integrationCredentials.id, eventReceipts.credentialId))
    .where(bodyWithoutDocument(source))
    .orderBy(asc(eventReceipts.deliveredAt))
    .limit(BACKFILL_BATCH_SIZE);

  let written = 0;

  for (const { receipt, accountId } of rows) {
    try {
      const projection = await prepareReceiptProjection({
        provider: source,
        userId: receipt.userId,
        eventType: receipt.eventType,
        rawKind: receipt.rawKind,
      });

      await db().transaction((tx) =>
        writeReceiptDocument(tx, projection, {
          id: receipt.id,
          body: receipt.payload,
          deliveredAt: receipt.deliveredAt,
          accountId,
        }),
      );
      written += 1;
    } catch (err) {
      logger.warn({ err }, `[ingestion:backfill] ${source} receipt ${receipt.id} not projected`);
    }
  }

  return written;
}
