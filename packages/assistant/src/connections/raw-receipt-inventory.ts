import {
  credentialProviderOf,
  type InboundEventSource,
  type LiveProviderSlug,
  type RawReceiptInventory,
} from "@alfred/contracts";
import { db } from "@alfred/db";
import { documents, eventReceipts, integrationCredentials } from "@alfred/db/schemas";
import { receiptDocumentJoin } from "./ingestion/receipt-document";
import { INBOUND_DAILY_EMBED_CAP, INBOUND_DAILY_EMBED_CAP_REASON } from "./receipt-corpus-policy";
import { and, count, desc, eq, isNotNull, max, type SQL } from "drizzle-orm";

/** Raw kinds in one scope, with count and last arrival, newest first. */
function rawKindGroups(scope: SQL | undefined) {
  const lastSeenAt = max(eventReceipts.deliveredAt);

  return db()
    .select({ rawKind: eventReceipts.rawKind, count: count(), lastSeenAt })
    .from(eventReceipts)
    .innerJoin(integrationCredentials, eq(integrationCredentials.id, eventReceipts.credentialId))
    .where(and(scope, isNotNull(eventReceipts.rawKind)))
    .groupBy(eventReceipts.rawKind)
    .orderBy(desc(lastSeenAt));
}

/**
 * Raw kinds for one integration's detail page (ADR-0097 item 9).
 * Scoped by the owning credential, not `event_receipts.provider`: integration
 * and event-source slugs are different spaces.
 */
export async function readRawReceiptInventory(
  userId: string,
  slug: LiveProviderSlug,
): Promise<RawReceiptInventory> {
  const rows = await rawKindGroups(
    and(
      eq(eventReceipts.userId, userId),
      eq(integrationCredentials.provider, credentialProviderOf(slug)),
    ),
  );

  const [capped] = await db()
    .select({ count: count() })
    .from(documents)
    .innerJoin(eventReceipts, receiptDocumentJoin())
    .innerJoin(integrationCredentials, eq(integrationCredentials.id, eventReceipts.credentialId))
    .where(
      and(
        eq(documents.userId, userId),
        eq(integrationCredentials.provider, credentialProviderOf(slug)),
        eq(documents.lastEmbedError, INBOUND_DAILY_EMBED_CAP_REASON),
        isNotNull(documents.embedFailedAt),
      ),
    );

  return {
    embedding: { dailyCap: INBOUND_DAILY_EMBED_CAP, cappedCount: capped?.count ?? 0 },
    kinds: rows.flatMap((row) =>
      // `IS NOT NULL` proves both; the type cannot see it.
      row.rawKind && row.lastSeenAt
        ? [{ kind: row.rawKind, count: row.count, lastSeenAt: row.lastSeenAt.toISOString() }]
        : [],
    ),
  };
}

const SEEN_RAW_KINDS_LIMIT = 100;

/** Kinds one event source has sent, so authoring can refuse a raw trigger on an unseen kind (#990). */
export async function seenRawKinds(userId: string, source: InboundEventSource): Promise<string[]> {
  const rows = await rawKindGroups(
    and(eq(eventReceipts.userId, userId), eq(eventReceipts.provider, source)),
  ).limit(SEEN_RAW_KINDS_LIMIT);

  // `IS NOT NULL` proves it; the type cannot see it.
  return rows.flatMap((row) => (row.rawKind ? [row.rawKind] : []));
}
