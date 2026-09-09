import { parseEventTypeName, type InboundEventSource } from "@alfred/contracts";
import { db } from "@alfred/db";
import { documents, eventReceipts, integrationCredentials } from "@alfred/db/schemas";
import { and, asc, eq, notExists } from "drizzle-orm";
import { resolveTimezone } from "@alfred/assistant/settings";
import { receiptDocumentJoin, writeReceiptDocument } from "./receipt-document";

/** Bounded recovery for receipts stored before corpus projection was installed. */
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
  }
}
