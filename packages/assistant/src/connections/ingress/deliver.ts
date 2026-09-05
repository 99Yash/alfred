import { isEventTypeForSource, isInboundEventSource, toMessage } from "@alfred/contracts";
import { db } from "@alfred/db";
import { eventReceipts, integrationCredentials } from "@alfred/db/schemas";
import { eq } from "drizzle-orm";
import { publishDomainEvent } from "@alfred/assistant/triggers";

/**
 * The `ingress.deliver` job body (ADR-0097): turn one pending receipt into one
 * domain event on the trigger bus. The event carries a pointer — the receipt
 * id and its dedup key — not the body; a consumer that needs the body reads
 * `event_receipts.payload` by id, the same pointer-not-content rule ADR-0047
 * set for Gmail.
 *
 * A receipt that is already `completed` is a no-op, so the queue's retries and
 * a redelivery's re-enqueue cannot publish twice. A `failed` receipt is retried:
 * the status records the last outcome, and the throw below is what lets the
 * queue schedule the next attempt.
 */
export async function deliverInboundReceipt(receiptId: string): Promise<void> {
  const [row] = await db()
    .select({ receipt: eventReceipts, accountRef: integrationCredentials.accountId })
    .from(eventReceipts)
    .innerJoin(integrationCredentials, eq(integrationCredentials.id, eventReceipts.credentialId))
    .where(eq(eventReceipts.id, receiptId))
    .limit(1);
  if (!row) {
    // Cascaded away with its credential; there is nobody to deliver to.
    console.warn(`[ingress] receipt ${receiptId} not found; skipping delivery`);
    return;
  }
  const { receipt } = row;
  if (receipt.processingStatus === "completed") return;

  const source = receipt.provider;
  if (!isInboundEventSource(source)) {
    throw new Error(`[ingress] receipt ${receiptId} has non-inbound provider '${source}'`);
  }
  const type = receipt.eventType.startsWith(`${source}.`)
    ? receipt.eventType.slice(source.length + 1)
    : receipt.eventType;
  if (!isEventTypeForSource(source, type)) {
    await markProcessed(receiptId, "failed");
    throw new Error(`[ingress] receipt ${receiptId} has unknown event type '${receipt.eventType}'`);
  }

  try {
    await publishDomainEvent({
      userId: receipt.userId,
      source,
      type,
      eventId: receipt.providerDeliveryId,
      accountRef: row.accountRef,
      payload: { receiptId, deliveryKey: receipt.providerDeliveryId },
    });
  } catch (error) {
    await markProcessed(receiptId, "failed");
    console.error(`[ingress] delivery of receipt ${receiptId} failed`, toMessage(error));
    throw error;
  }
  await markProcessed(receiptId, "completed");
}

async function markProcessed(receiptId: string, status: "completed" | "failed"): Promise<void> {
  await db()
    .update(eventReceipts)
    .set({ processingStatus: status, processedAt: new Date(), updatedAt: new Date() })
    .where(eq(eventReceipts.id, receiptId));
}
