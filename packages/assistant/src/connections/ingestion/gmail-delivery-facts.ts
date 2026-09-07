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
 * The delivery facts one Gmail credential's ingestion leaves behind, read for
 * the two surfaces that judge the push path: workflow trigger readiness
 * (`automation/gmail-event-readiness.ts`) and the integration status the Gmail
 * page renders (`connections/availability.ts`).
 *
 * The cheap `@alfred/assistant/connections` barrel can reach this reader without
 * evaluating the ingestion queue or the Gmail ingestor.
 */
export type GmailDeliveryFacts = Pick<
  IngestionState,
  "lastSyncAt" | "lastWebhookSyncAt" | "lastFallbackInsertAt"
> & {
  /** The rolling `history.list` cursor is seeded. */
  cursorReady: boolean;
  /** #560b: a cursor jump or a gone history was detected and not yet repaired. */
  coverageGap: boolean;
  /**
   * #998: last verified Pub/Sub push for this credential, from `event_receipts`
   * (ADR-0090). The webhook writes a receipt even when the queue deduplicates
   * the poll, so this is the push path's own heartbeat.
   */
  lastPushDeliveredAt: EventReceipt["deliveredAt"] | null;
};

/**
 * Account status evidence, including the meaning of its baseline. Poll starts
 * exclude processing delay; announced changes do not stamp fallback evidence.
 * A quiet mailbox produces no evidence. A receipt proves transport delivery,
 * while `lastWebhookSyncAt` separately records successful fetch/persist work.
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
 * Read {@link GmailDeliveryFacts} for every Gmail cursor row of one user, keyed
 * by credential id. A credential with no `ingestion_state` row is absent: it has
 * nothing to deliver from yet, and the readers treat absence as "no watch".
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
