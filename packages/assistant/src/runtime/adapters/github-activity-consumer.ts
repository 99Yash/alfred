import { getStringPath, jsonObjectSchema } from "@alfred/contracts";
import { db } from "@alfred/db";
import { eventReceipts, webhookEvents } from "@alfred/db/schemas";
import { and, eq } from "drizzle-orm";
import { objectStateStore } from "@alfred/assistant/connections";
import { githubInstallationId } from "@alfred/assistant/connections/ingress";
import { inboundDeliveryPayloadSchema, type TriggerConsumer } from "@alfred/assistant/triggers";

/**
 * The GitHub activity fold, as a trigger consumer (ADR-0047, ADR-0062,
 * ADR-0097). The old `/webhooks/github` handler wrote `webhook_events` and ran
 * the object-state reducer inline; the ingress route now only stores a receipt
 * and publishes `github.<event>` on the bus, and this consumer reacts to it.
 * The briefing's `integration_activity` contributor and the ADR-0062 reducer
 * keep reading `webhook_events`, so the rows they see are unchanged.
 *
 * `best-effort`: a fold failure must never fail the delivery job (the receipt
 * is durable; a backfill can replay it), the same isolation the inline handler
 * had. The reducer runs only for a newly inserted `webhook_events` row, so a
 * redelivered receipt cannot regress object state with a fresh timestamp.
 */
export function githubActivityTriggerConsumer(): TriggerConsumer {
  return {
    name: "github-activity-fold",
    mode: "best-effort",
    async accept(event) {
      if (event.source !== "github") return;
      const { receiptId } = inboundDeliveryPayloadSchema.parse(event.payload ?? {});
      const [receipt] = await db()
        .select({
          providerDeliveryId: eventReceipts.providerDeliveryId,
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

      const installationId = githubInstallationId(payload);
      const action = getStringPath(payload, "action") ?? null;
      const inserted = await db()
        .insert(webhookEvents)
        .values({
          provider: "github",
          providerEventId: receipt.providerDeliveryId,
          eventType: event.type,
          action,
          repo: getStringPath(payload, "repository", "full_name") ?? null,
          installationId,
          userId: event.userId,
          payload,
          deliveredAt: receipt.deliveredAt,
        })
        .onConflictDoNothing({ target: [webhookEvents.provider, webhookEvents.providerEventId] })
        .returning({ deliveredAt: webhookEvents.deliveredAt });
      if (!inserted[0]) return;

      await objectStateStore.applyEvent({
        userId: event.userId,
        provider: "github",
        eventType: event.type,
        action,
        payload,
        deliveredAt: inserted[0].deliveredAt,
      });
    },
  };
}
