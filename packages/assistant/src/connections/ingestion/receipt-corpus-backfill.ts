import { toMessage, type InboundEventSource } from "@alfred/contracts";
import { db } from "@alfred/db";
import { documents, eventReceipts, integrationCredentials } from "@alfred/db/schemas";
import { and, asc, eq, notExists } from "drizzle-orm";
import {
  prepareReceiptProjection,
  receiptDocumentJoin,
  writeReceiptDocument,
} from "./receipt-document";

/**
 * Project receipts that have no corpus document, in a bounded batch. Catch per row: one bad row
 * must not fail the whole `gmail.embed_sweep` `Promise.all`. A skipped row is retried next tick.
 */
export async function backfillReceiptDocuments(source: InboundEventSource): Promise<void> {
  const rows = await db()
    .select({ receipt: eventReceipts, accountId: integrationCredentials.accountId })
    .from(eventReceipts)
    .innerJoin(integrationCredentials, eq(integrationCredentials.id, eventReceipts.credentialId))
    .where(
      and(
        eq(eventReceipts.provider, source),
        notExists(db().select({ id: documents.id }).from(documents).where(receiptDocumentJoin())),
      ),
    )
    .orderBy(asc(eventReceipts.deliveredAt))
    .limit(50);

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
          payload: receipt.payload,
          deliveredAt: receipt.deliveredAt,
          accountId,
        }),
      );
    } catch (err) {
      console.warn(
        `[ingestion:backfill] ${source} receipt ${receipt.id} not projected:`,
        toMessage(err),
      );
    }
  }
}
