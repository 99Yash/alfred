import { GMAIL_PUSH_STALE_AFTER_MS, getPath, getStringPath } from "@alfred/contracts";
import { db } from "@alfred/db";
import { ingestionState, typedEventReceipts } from "@alfred/db/schemas";
import { and, eq, sql } from "drizzle-orm";

/**
 * The delivery facts one Gmail credential's ingestion leaves behind, read for
 * the two surfaces that judge the push path: workflow trigger readiness
 * (`automation/gmail-event-readiness.ts`) and the integration status the Gmail
 * page renders (`connections/availability.ts`).
 *
 * This is a leaf on purpose. It imports the database and the contracts only, so
 * the cheap `@alfred/assistant/connections` barrel can reach it without
 * evaluating the ingestion queue or the Gmail ingestor.
 */
export interface GmailDeliveryFacts {
  /** The rolling `history.list` cursor is seeded. */
  cursorReady: boolean;
  /** #560b: a cursor jump or a gone history was detected and not yet repaired. */
  coverageGap: boolean;
  /** Last successful sync on any path. */
  lastSyncAt: Date | null;
  /** #998: last time the poll-fallback sweep inserted a message. */
  lastFallbackInsertAt: Date | null;
  /**
   * #998: last verified Pub/Sub push for this credential, from `event_receipts`
   * (ADR-0090). The webhook writes a receipt even when the queue deduplicates
   * the poll, so this is the push path's own heartbeat.
   */
  lastPushDeliveredAt: Date | null;
}

/**
 * When Gmail push stopped delivering for one credential, or `null` while push is
 * live or unproven (#998).
 *
 * The evidence is an insert on the poll-fallback path: Gmail publishes a push
 * for every mailbox change, so a message only the sweep found is a push that
 * never arrived. A quiet mailbox produces no fallback insert, so it never reads
 * stale. The baseline is the last push receipt, or the watch install when no
 * push has ever arrived; the insert must trail it by
 * {@link GMAIL_PUSH_STALE_AFTER_MS} so a sweep poll that wins the race against
 * the push for the same message does not count. The value returned is the
 * baseline: the last moment push is known to have worked.
 */
export function gmailPushStaleSince(
  facts: Pick<GmailDeliveryFacts, "lastFallbackInsertAt" | "lastPushDeliveredAt">,
  watchInstalledAt: Date | null,
): Date | null {
  if (!facts.lastFallbackInsertAt) return null;
  const baseline = facts.lastPushDeliveredAt ?? watchInstalledAt;
  if (!baseline) return null;
  const trail = facts.lastFallbackInsertAt.getTime() - baseline.getTime();
  return trail > GMAIL_PUSH_STALE_AFTER_MS ? baseline : null;
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
        lastFallbackInsertAt: ingestionState.lastFallbackInsertAt,
      })
      .from(ingestionState)
      .where(
        and(
          eq(ingestionState.userId, userId),
          eq(ingestionState.provider, "google"),
          eq(ingestionState.stream, "messages"),
        ),
      ),
    db()
      .select({
        credentialId: typedEventReceipts.credentialId,
        lastPushDeliveredAt: sql<Date | null>`max(${typedEventReceipts.deliveredAt})`.mapWith(
          typedEventReceipts.deliveredAt,
        ),
      })
      .from(typedEventReceipts)
      .where(and(eq(typedEventReceipts.userId, userId), eq(typedEventReceipts.provider, "google")))
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
        lastFallbackInsertAt: row.lastFallbackInsertAt,
        lastPushDeliveredAt: pushByCredential.get(row.credentialId) ?? null,
      },
    ]),
  );
}
