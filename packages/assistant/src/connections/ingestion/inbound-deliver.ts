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
 * The `ingress.deliver` job body (ADR-0097): turn one pending receipt into one
 * domain event on the trigger bus. The event carries a pointer — the receipt
 * id and its dedup key — not the body; a consumer that needs the body reads
 * `event_receipts.payload` by id, the same pointer-not-content rule ADR-0047
 * set for Gmail.
 *
 * Both tiers pass through here (ADR-0097 item 11, #990). A typed receipt
 * publishes `<source>.<type>`. A raw receipt publishes `<source>.raw` with its
 * `raw_kind`, so a user-authored trigger on that kind can match; a raw row's
 * `event_type` is never parsed, because `raw_kind` already is the tier. This is
 * why the read below is on the table and not on `typedEventReceipts`, and why
 * the file is named in the receipt-read gate's owners.
 *
 * A receipt that is already `completed` is a no-op, so the queue's retries and
 * a redelivery's re-enqueue cannot publish twice. A `failed` receipt is retried:
 * the status records the last outcome, and the throw below is what lets the
 * queue schedule the next attempt. A typed receipt whose stored event type is
 * not one its source declares is a permanent data error: it is marked `failed`
 * and the job returns, so the queue does not spend five attempts on a row that
 * cannot change.
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
