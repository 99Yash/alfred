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
 * The object-state fold: one trigger consumer per provider (ADR-0047, ADR-0062, ADR-0097). Reads
 * the receipt back by id and runs the provider reducer over its body. `propagate`: a fold failure
 * fails `ingress.deliver` and the queue retries. Reducers are idempotent, so a retry cannot regress
 * state. Raw events have no reducer and return early.
 */

/**
 * Inbound source per object-state provider. Two slug spaces (ADR-0097 item 5) that mostly spell the
 * same. `null` means no inbound source. A provider without a row is a type error.
 */
const FOLD_SOURCES = {
  github: "github",
  sentry: "sentry",
  // Pull-only: `connections/verified-pull` calls the store with a minted receipt.
  railway: null,
  // Vercel deploys arrive as GitHub `repository_dispatch`. Both consumers read each GitHub receipt,
  // and each reducer returns `[]` for types it does not own.
  vercel: "github",
  // Pull-only and descriptor-reviewed; no inbound source may feed it.
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
    // Docs cite `github-activity-fold`, so the name pattern stays.
    name: `${provider}-activity-fold`,
    mode: "propagate",
    async accept(event) {
      if (event.source !== source || isRawEventType(event.type)) return;
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
      // A NULL or foreign shape cannot fold, and a retry would not change it.
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
