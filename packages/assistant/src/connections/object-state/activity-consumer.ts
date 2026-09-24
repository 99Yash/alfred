import {
  getStringPath,
  type InboundEventSource,
  isRawEventType,
  jsonObjectSchema,
  OBJECT_STATE_PROVIDERS,
  type ObjectStateProvider,
} from "@alfred/contracts";
import { db } from "@alfred/db";
import { typedEventReceipts } from "@alfred/db/schemas";
import { and, eq } from "drizzle-orm";
import { receiptDeliveryInstant } from "./delivery-instant";
import { objectStateStore } from "./store";
import { inboundDeliveryPayloadSchema, type TriggerConsumer } from "@alfred/assistant/triggers";

/**
 * The object-state fold, as one trigger consumer per provider (ADR-0047,
 * ADR-0062, ADR-0097). The ingress route stores one `event_receipts` row per
 * verified delivery and publishes `<source>.<event>` on the bus; this consumer
 * reads the receipt back by id and runs the ADR-0062 object-state reducer over
 * its body. The receipt is the only copy of the delivery: the briefing's
 * `integration_activity` contributor and the committed object-state backfill
 * read the same rows (#975 retired the `webhook_events` projection).
 *
 * `propagate`: a fold failure fails the `ingress.deliver` job, the receipt
 * reads `failed`, and the queue retries. Every reducer is idempotent —
 * monotonic on `stateDeliveredAt` with the per-kind absorbing guard, keyed on
 * the receipt's own `delivered_at` at the microsecond resolution Postgres
 * records it, while a CI target row orders by the
 * `(providerEventTime, deliveredAt)` pair — so a retry re-applies the same
 * event with the same timestamps and cannot regress object state. Redelivery dedup lives
 * one layer up: the receive path inserts the receipt `onConflictDoNothing` on
 * `(provider, provider_delivery_id)`, and the deliver job skips a `completed`
 * row, so a replayed delivery never reaches this consumer twice.
 *
 * A raw event (`github.raw`, `sentry.raw`, #990) is a kind no registry names,
 * so no reducer has a rule for it; the consumer returns before the receipt
 * read rather than fetching a row the typed view would not return.
 */

/**
 * Which inbound event source feeds each object-state provider. TWO slug spaces
 * meet here (ADR-0097 item 5): the left key is an `ObjectStateProvider`, the
 * right value is an `InboundEventSource`. They happen to spell the same today.
 * `null` is the arm for a provider with no inbound source, so a future
 * pull-only provider states its absence instead of inheriting a wrong source.
 *
 * This is the table that makes "the fold is wired" a compiler fact rather than
 * a reviewer's memory: a provider added to the registry without a row here is
 * a type error.
 */
const FOLD_SOURCES = {
  github: "github",
  sentry: "sentry",
  // Railway is pull-only: no webhook, no poller, no inbound source. The null
  // arm states that absence instead of inheriting a wrong source, so no
  // `railway-activity-fold` consumer is registered and the verified-pull seam
  // (`connections/verified-pull`) calls the store directly with a minted receipt.
  railway: null,
  // Vercel rides GitHub's webhook: every Vercel deployment state change
  // arrives as a `repository_dispatch` delivery on the github source, so this
  // is the row where the two slug spaces genuinely DIVERGE rather than
  // happening to spell the same. The consequence is deliberate: two consumers
  // (`github-activity-fold` and `vercel-activity-fold`) now read the same
  // receipt row per GitHub delivery, and each reducer answers `[]` for the
  // event types it does not own. That is one extra primary-key select on a
  // consumer already doing database work — cheaper than a per-provider
  // event-type filter that every provider would have to declare.
  vercel: "github",
  // MCP health mappings are pull-only and descriptor-reviewed; no inbound
  // source may feed this provider's generic reducer.
  mcp: null,
} as const satisfies Record<ObjectStateProvider, InboundEventSource | null>;

/** One fold consumer per provider that has an inbound source. */
export function objectStateFoldConsumers(): TriggerConsumer[] {
  const consumers: TriggerConsumer[] = [];

  for (const provider of OBJECT_STATE_PROVIDERS) {
    const source: InboundEventSource | null = FOLD_SOURCES[provider];

    if (source === null) continue;
    consumers.push(objectStateFoldConsumer(provider, source));
  }

  return consumers;
}

function objectStateFoldConsumer(
  provider: ObjectStateProvider,
  source: InboundEventSource,
): TriggerConsumer {
  return {
    // The GitHub consumer's name predates the second provider and four docs
    // cite it, so the pattern keeps it rather than renaming a live consumer
    // for symmetry.
    name: `${provider}-activity-fold`,
    mode: "propagate",
    async accept(event) {
      if (event.source !== source || isRawEventType(event.type)) return;
      const { receiptId } = inboundDeliveryPayloadSchema.parse(event.payload ?? {});

      const [receipt] = await db()
        .select({
          payload: typedEventReceipts.payload,
          // Not the raw column: `node-postgres` would hand back a JS `Date`,
          // which holds milliseconds, and the store orders two folds of one
          // object on this value at microsecond resolution (#1200).
          deliveredAt: receiptDeliveryInstant(),
        })
        .from(typedEventReceipts)
        .where(
          and(eq(typedEventReceipts.id, receiptId), eq(typedEventReceipts.userId, event.userId)),
        )
        .limit(1);

      if (!receipt) return;
      // The receive path stored a parsed JSON object; a NULL or foreign shape
      // here is a receipt this consumer cannot fold, not an error to retry.
      const stored = jsonObjectSchema.safeParse(receipt.payload);

      if (!stored.success) return;
      const payload = stored.data;

      await objectStateStore.applyEvent({
        userId: event.userId,
        provider,
        eventType: event.type,
        action: getStringPath(payload, "action") ?? null,
        payload,
        deliveredAt: receipt.deliveredAt,
      });
    },
  };
}
