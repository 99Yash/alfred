import {
  isInboundEventSource,
  parseEventTypeName,
  RAW_EVENT_TYPE,
  toMessage,
} from "@alfred/contracts";
import { db } from "@alfred/db";
import { eventReceipts, integrationCredentials } from "@alfred/db/schemas";
import { eq } from "drizzle-orm";
import { publishDomainEvent, type DomainEvent } from "@alfred/assistant/triggers";

/**
 * The `ingress.deliver` job (ADR-0097): publish one pending receipt as one domain event. The event
 * carries a pointer (receipt id and dedup key), never the body. Raw receipts publish `<source>.raw`
 * with `raw_kind`, so this reads the table, not the typed view. `completed` is a no-op, so retries
 * cannot publish twice. A typed receipt with an unknown event type is marked `failed` and not
 * retried, because it cannot change.
 */
export async function deliverInboundReceipt(receiptId: string): Promise<void> {
  const [row] = await db()
    .select({
      receipt: {
        provider: eventReceipts.provider,
        eventType: eventReceipts.eventType,
        rawKind: eventReceipts.rawKind,
        processingStatus: eventReceipts.processingStatus,
        userId: eventReceipts.userId,
        providerDeliveryId: eventReceipts.providerDeliveryId,
      },
      accountRef: integrationCredentials.accountId,
    })
    .from(eventReceipts)
    .innerJoin(integrationCredentials, eq(integrationCredentials.id, eventReceipts.credentialId))
    .where(eq(eventReceipts.id, receiptId))
    .limit(1);

  if (!row) {
    console.warn(`[ingress] receipt ${receiptId} not found; skipping delivery`);

    return;
  }

  const { receipt } = row;

  if (receipt.processingStatus === "completed") return;

  const source = receipt.provider;

  if (!isInboundEventSource(source)) {
    throw new Error(`[ingress] receipt ${receiptId} has non-inbound provider '${source}'`);
  }

  const payload = { receiptId, deliveryKey: receipt.providerDeliveryId };
  let event: DomainEvent;

  if (receipt.rawKind !== null) {
    event = {
      userId: receipt.userId,
      source,
      type: RAW_EVENT_TYPE,
      rawKind: receipt.rawKind,
      eventId: receipt.providerDeliveryId,
      accountRef: row.accountRef,
      payload,
    };
  } else {
    const type = parseEventTypeName(source, receipt.eventType);

    if (!type) {
      await markProcessed(receiptId, "failed");
      console.error(`[ingress] receipt ${receiptId} has unknown event type '${receipt.eventType}'`);

      return;
    }

    event = {
      userId: receipt.userId,
      source,
      type,
      eventId: receipt.providerDeliveryId,
      accountRef: row.accountRef,
      payload,
    };
  }

  try {
    await publishDomainEvent(event);
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
