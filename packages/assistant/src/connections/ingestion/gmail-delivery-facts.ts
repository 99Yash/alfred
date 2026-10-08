import {
  eventDeliveryAccounts,
  getPath,
  getStringPath,
  type ConnectedAccount,
  type LoadableIntegrationSlug,
  type ProviderAvailability,
} from "@alfred/contracts";
import { db } from "@alfred/db";
import {
  ingestionState,
  typedEventReceipts,
  type IngestionState,
  type EventReceipt,
} from "@alfred/db/schemas";
import { readGmailWatchState } from "@alfred/integrations/google";
import { and, eq, max } from "drizzle-orm";
import { GMAIL_PUSH_DELIVERY_GRACE_MS } from "./gmail-delivery-policy";

const GMAIL_DELIVERY = eventDeliveryAccounts("gmail");

/**
 * Delivery facts for one Gmail credential, for trigger readiness (`gmail-event-health.ts`) and the
 * Gmail status page (`connections/availability.ts`). Reachable without loading the ingestion queue.
 */
export type GmailDeliveryFacts = Pick<
  IngestionState,
  "lastSyncAt" | "lastWebhookSyncAt" | "lastFallbackInsertAt"
> & {
  /** The `history.list` cursor is seeded. */
  cursorReady: boolean;
  /** A cursor jump or gone history is not yet repaired (#560b). */
  coverageGap: boolean;
  /**
   * Last Pub/Sub push receipt (#998). Written even when the poll job is deduped, so it is the push
   * heartbeat.
   */
  lastPushDeliveredAt: EventReceipt["deliveredAt"] | null;
};

/**
 * Whether push looks stale: a fallback poll found unannounced mail later than the grace after the
 * last push (or the watch install). A quiet mailbox gives no evidence either way.
 */
export function gmailPushStaleStatus(
  byCredential: ReadonlyMap<string, GmailDeliveryFacts>,
  row: Pick<ProviderAvailability, "credentialId" | "metadata">,
  slug: LoadableIntegrationSlug,
): ConnectedAccount["pushStale"] {
  if (slug !== GMAIL_DELIVERY.integration) return null;
  const facts = byCredential.get(row.credentialId);

  if (!facts?.lastFallbackInsertAt) return null;
  const watch = readGmailWatchState(row.metadata);
  const baseline = facts.lastPushDeliveredAt ?? (watch ? new Date(watch.installedAt) : null);

  if (!baseline) return null;
  const trail = facts.lastFallbackInsertAt.getTime() - baseline.getTime();

  return trail > GMAIL_PUSH_DELIVERY_GRACE_MS
    ? {
        since: baseline.toISOString(),
        baseline: facts.lastPushDeliveredAt ? "push-received" : "watch-installed",
      }
    : null;
}

/**
 * Delivery facts per credential for one user. A credential with no `ingestion_state` row is absent.
 */
export async function readGmailDeliveryFacts(
  userId: string,
): Promise<ReadonlyMap<string, GmailDeliveryFacts>> {
  const [cursors, pushes] = await Promise.all([
    db()
      .select({
        credentialId: ingestionState.credentialId,
        state: ingestionState.state,
        lastSyncAt: ingestionState.lastSyncAt,
        lastWebhookSyncAt: ingestionState.lastWebhookSyncAt,
        lastFallbackInsertAt: ingestionState.lastFallbackInsertAt,
      })
      .from(ingestionState)
      .where(
        and(
          eq(ingestionState.userId, userId),
          eq(ingestionState.provider, GMAIL_DELIVERY.provider),
          eq(ingestionState.stream, "messages"),
        ),
      ),
    db()
      .select({
        credentialId: typedEventReceipts.credentialId,
        lastPushDeliveredAt: max(typedEventReceipts.deliveredAt),
      })
      .from(typedEventReceipts)
      .where(
        and(
          eq(typedEventReceipts.userId, userId),
          eq(typedEventReceipts.provider, GMAIL_DELIVERY.provider),
        ),
      )
      .groupBy(typedEventReceipts.credentialId),
  ]);

  const pushByCredential = new Map(
    pushes.map((row) => [row.credentialId, row.lastPushDeliveredAt] as const),
  );

  return new Map(
    cursors.map((row): [string, GmailDeliveryFacts] => [
      row.credentialId,
      {
        cursorReady: Boolean(getStringPath(row.state, "historyId")),
        coverageGap: getPath(row.state, "coverageGap") === true,
        lastSyncAt: row.lastSyncAt,
        lastWebhookSyncAt: row.lastWebhookSyncAt,
        lastFallbackInsertAt: row.lastFallbackInsertAt,
        lastPushDeliveredAt: pushByCredential.get(row.credentialId) ?? null,
      },
    ]),
  );
}
