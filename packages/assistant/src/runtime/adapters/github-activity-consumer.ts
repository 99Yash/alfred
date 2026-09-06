import { getStringPath, jsonObjectSchema } from "@alfred/contracts";
import { db } from "@alfred/db";
import { eventReceipts } from "@alfred/db/schemas";
import { and, eq } from "drizzle-orm";
import { objectStateStore } from "@alfred/assistant/connections";
import { inboundDeliveryPayloadSchema, type TriggerConsumer } from "@alfred/assistant/triggers";

/**
 * The GitHub activity fold, as a trigger consumer (ADR-0047, ADR-0062,
 * ADR-0097). The ingress route stores one `event_receipts` row per verified
 * delivery and publishes `github.<event>` on the bus; this consumer reads the
 * receipt back by id and runs the ADR-0062 object-state reducer over its body.
 * The receipt is the only copy of the delivery: the briefing's
 * `integration_activity` contributor and the committed object-state backfill
 * read the same rows (#975 retired the `webhook_events` projection).
 *
 * `propagate`: a fold failure fails the `ingress.deliver` job, the receipt
 * reads `failed`, and the queue retries. The reducer is idempotent — monotonic
 * on `stateDeliveredAt` with an absorbing `resolved` guard, keyed on the
 * receipt's own `delivered_at` — so a retry re-applies the same event with the
 * same timestamp and cannot regress object state. Redelivery dedup lives one
 * layer up: the receive path inserts the receipt `onConflictDoNothing` on
 * `(provider, provider_delivery_id)`, and the deliver job skips a `completed`
 * row, so a replayed delivery never reaches this consumer twice.
 */
export function githubActivityTriggerConsumer(): TriggerConsumer {
  return {
    name: "github-activity-fold",
    mode: "propagate",
    async accept(event) {
      if (event.source !== "github") return;
      const { receiptId } = inboundDeliveryPayloadSchema.parse(event.payload ?? {});
      const [receipt] = await db()
        .select({
          payload: eventReceipts.payload,
          deliveredAt: eventReceipts.deliveredAt,
        })
        .from(eventReceipts)
        .where(and(eq(eventReceipts.id, receiptId), eq(eventReceipts.userId, event.userId)))
        .limit(1);
      if (!receipt) return;
      // The receive path stored a parsed JSON object; a NULL or foreign shape
      // here is a receipt this consumer cannot fold, not an error to retry.
      const stored = jsonObjectSchema.safeParse(receipt.payload);
      if (!stored.success) return;
      const payload = stored.data;

      await objectStateStore.applyEvent({
        userId: event.userId,
        provider: "github",
        eventType: event.type,
        action: getStringPath(payload, "action") ?? null,
        payload,
        deliveredAt: receipt.deliveredAt,
      });
    },
  };
}
