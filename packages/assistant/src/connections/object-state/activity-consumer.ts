import {
  INBOUND_EVENT_SOURCES,
  type InboundEventSource,
  isEventTypeForSource,
  isRawEventType,
} from "@alfred/contracts";
import { db } from "@alfred/db";
import { typedEventReceipts } from "@alfred/db/schemas";
import { and, eq } from "drizzle-orm";
import { receiptDeliveryInstant } from "./delivery-instant";
import { parseReceiptEvent } from "./events";
import { objectStateStore } from "./store";
import { inboundDeliveryPayloadSchema, type TriggerConsumer } from "@alfred/assistant/triggers";

/**
 * The object-state fold: one trigger consumer per inbound source (ADR-0047, ADR-0062, ADR-0097).
 * Reads the receipt back by id, parses it once into its provider's event, and runs that reducer.
 * Vercel deploys arrive as GitHub `repository_dispatch`, so the GitHub consumer folds them too.
 * `propagate`: a fold failure fails `ingress.deliver` and the queue retries. Reducers are
 * idempotent, so a retry cannot regress state. Raw events have no reducer and return early.
 */
export function objectStateFoldConsumers(): TriggerConsumer[] {
  return INBOUND_EVENT_SOURCES.map((source) => objectStateFoldConsumer(source));
}

function objectStateFoldConsumer<S extends InboundEventSource>(source: S): TriggerConsumer {
  return {
    // Docs cite `github-activity-fold`, so the name pattern stays.
    name: `${source}-activity-fold`,
    mode: "propagate",
    async accept(event) {
      if (event.source !== source || isRawEventType(event.type)) return;

      // `domainEventSchema` already refuses a type of another source; this only narrows.
      if (!isEventTypeForSource(source, event.type)) return;
      const { receiptId } = inboundDeliveryPayloadSchema.parse(event.payload ?? {});

      const [receipt] = await db()
        .select({
          payload: typedEventReceipts.payload,
          // Not the raw column: a JS `Date` drops the microseconds the store orders on (#1200).
          deliveredAt: receiptDeliveryInstant(),
        })
        .from(typedEventReceipts)
        .where(
          and(eq(typedEventReceipts.id, receiptId), eq(typedEventReceipts.userId, event.userId)),
        )
        .limit(1);

      if (!receipt) return;
      // A type that folds nothing, or a body that is not an object. A retry would not change it.
      const parsed = parseReceiptEvent(source, event.type, receipt.payload);

      if (!parsed) return;

      await objectStateStore.applyEvent({
        userId: event.userId,
        event: parsed,
        deliveredAt: receipt.deliveredAt,
      });
    },
  };
}
