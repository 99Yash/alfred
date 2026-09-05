import { getStringPath, jsonObjectSchema } from "@alfred/contracts";
import { db } from "@alfred/db";
import { eventReceipts, webhookEvents } from "@alfred/db/schemas";
import { and, eq } from "drizzle-orm";
import { githubInstallationId } from "@alfred/integrations/github";
import { objectStateStore } from "@alfred/assistant/connections";
import { inboundDeliveryPayloadSchema, type TriggerConsumer } from "@alfred/assistant/triggers";

/**
 * The GitHub activity fold, as a trigger consumer (ADR-0047, ADR-0062,
 * ADR-0097). The old `/webhooks/github` handler wrote `webhook_events` and ran
 * the object-state reducer inline; the ingress route now only stores a receipt
 * and publishes `github.<event>` on the bus, and this consumer reacts to it.
 * The briefing's `integration_activity` contributor and the ADR-0062 reducer
 * keep reading `webhook_events`, so the rows they see are unchanged.
 *
 * `propagate`: a fold failure fails the `ingress.deliver` job, the receipt
 * reads `failed`, and the queue retries. Both writes are idempotent — the
 * `webhook_events` insert is `onConflictDoNothing`, and `applyEvent` is
 * monotonic on `stateDeliveredAt` with an absorbing `resolved` guard — so a
 * retry is safe, and the reducer runs only for a newly inserted row, so a
 * redelivered receipt cannot regress object state with a fresh timestamp. The
 * inline handler isolated the reducer so its error could not 500 the provider;
 * inside a queued job that reason is gone, and `best-effort` would turn a lost
 * `webhook_events` row into a silent, permanent gap, because no reconciler
 * reads `event_receipts.payload` back into this table.
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
