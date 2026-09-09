import { parseEventTypeName, toMessage, type InboundEventSource } from "@alfred/contracts";
import { db } from "@alfred/db";
import { documents, eventReceipts, integrationCredentials } from "@alfred/db/schemas";
import { and, asc, eq, notExists } from "drizzle-orm";
import { resolveTimezone } from "@alfred/assistant/settings";
import { receiptDocumentJoin, writeReceiptDocument } from "./receipt-document";

/**
 * Bounded recovery for receipts stored before corpus projection was installed.
 *
 * Each receipt is projected in its own try/catch. The caller runs one backfill
 * per inbound source inside a single `Promise.all` in the `gmail.embed_sweep`
 * job, so an unhandled throw here would fail the whole sweep — every source's
 * batch, plus the Gmail and attachment batches — on one bad row. A row that
 * cannot be projected is logged and skipped; the next tick retries it, because
 * the `notExists` filter still selects it.
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
    const kind =
      receipt.rawKind ?? parseEventTypeName(source, receipt.eventType) ?? receipt.eventType;
    try {
      const timezone = await resolveTimezone(receipt.userId);
      await db().transaction((tx) =>
        writeReceiptDocument(
          tx,
          {
            ...receipt,
            provider: source,
            kind,
            accountId,
          },
          timezone,
        ),
      );
    } catch (err) {
      console.warn(
        `[ingestion:backfill] ${source} receipt ${receipt.id} not projected:`,
        toMessage(err),
      );
    }
  }
}
