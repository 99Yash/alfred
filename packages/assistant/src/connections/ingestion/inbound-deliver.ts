import {
  type InboundEventSource,
  isInboundEventSource,
  parseEventTypeName,
  RAW_EVENT_TYPE,
} from "@alfred/contracts";
import { db } from "@alfred/db";
import { eventReceipts, integrationCredentials } from "@alfred/db/schemas";
import { eq } from "drizzle-orm";
import {
  publishDomainEvent,
  type DomainEvent,
  type InboundDomainEvent,
} from "@alfred/assistant/triggers";
import { logger } from "@alfred/logging";

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
    logger.warn(`[ingress] receipt ${receiptId} not found; skipping delivery`);

    return;
  }

  const { receipt } = row;

  if (receipt.processingStatus === "completed") return;

  const source = receipt.provider;

  if (!isInboundEventSource(source)) {
    throw new Error(`[ingress] receipt ${receiptId} has non-inbound provider '${source}'`);
  }

  const payload: InboundDomainEvent["payload"] = {
    receiptId,
    deliveryKey: receipt.providerDeliveryId,
  };

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
    const typed = typedInboundEvent(source, receipt.eventType, {
      userId: receipt.userId,
      eventId: receipt.providerDeliveryId,
      accountRef: row.accountRef,
      payload,
    });

    if (!typed) {
      await markProcessed(receiptId, "failed");
      logger.error(`[ingress] receipt ${receiptId} has unknown event type '${receipt.eventType}'`);

      return;
    }

    event = typed;
  }

  try {
    await publishDomainEvent(event);
  } catch (error) {
    await markProcessed(receiptId, "failed");
    logger.error({ err: error }, `[ingress] delivery of receipt ${receiptId} failed`);
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

type InboundEventFields = Pick<DomainEvent, "userId" | "eventId" | "accountRef"> & {
  payload: InboundDomainEvent["payload"];
};

/**
 * The typed event of one receipt, or null when its stored type is not declared. One case per
 * source, because the compiler correlates `type` with `source` only for a literal source.
 * A new inbound source fails to compile here until it has a case.
 */
function typedInboundEvent(
  source: InboundEventSource,
  eventTypeName: string,
  fields: InboundEventFields,
): DomainEvent | null {
  switch (source) {
    case "github": {
      const type = parseEventTypeName(source, eventTypeName);

      return type ? { ...fields, source, type } : null;
    }

    case "sentry": {
      const type = parseEventTypeName(source, eventTypeName);

      return type ? { ...fields, source, type } : null;
    }
  }
}
