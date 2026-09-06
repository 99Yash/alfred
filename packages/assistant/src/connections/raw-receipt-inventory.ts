import {
  credentialProviderOf,
  type LiveProviderSlug,
  type RawReceiptInventory,
} from "@alfred/contracts";
import { db } from "@alfred/db";
import { documents, eventReceipts, integrationCredentials } from "@alfred/db/schemas";
import { INBOUND_DAILY_EMBED_CAP, INBOUND_DAILY_EMBED_CAP_REASON } from "./receipt-corpus-policy";
import { and, count, desc, eq, isNotNull, max } from "drizzle-orm";

/**
 * The raw receipt inventory of one integration for one user (ADR-0097 item 9):
 * each provider kind the registry does not name, how many verified deliveries
 * carried it, and when the last one arrived. This is how a new provider
 * resource becomes visible the day it starts to arrive, on the integration
 * detail page.
 *
 * The rows are selected through the credential that owns them, not through
 * `event_receipts.provider`: an integration slug and an event-source slug are
 * different spaces (ADR-0097 item 5), and the credential join is the one link
 * the receipt itself records. A Google slug therefore reads an empty inventory,
 * because no raw receipt is ever attributed to a Google credential.
 */
export async function readRawReceiptInventory(
  userId: string,
  slug: LiveProviderSlug,
): Promise<RawReceiptInventory> {
  const lastSeenAt = max(eventReceipts.deliveredAt);
  const rows = await db()
    .select({ rawKind: eventReceipts.rawKind, count: count(), lastSeenAt })
    .from(eventReceipts)
    .innerJoin(integrationCredentials, eq(integrationCredentials.id, eventReceipts.credentialId))
    .where(
      and(
        eq(eventReceipts.userId, userId),
        eq(integrationCredentials.provider, credentialProviderOf(slug)),
        isNotNull(eventReceipts.rawKind),
      ),
    )
    .groupBy(eventReceipts.rawKind)
    .orderBy(desc(lastSeenAt));

  const [capped] = await db()
    .select({ count: count() })
    .from(documents)
    .innerJoin(eventReceipts, eq(documents.sourceId, eventReceipts.id))
    .innerJoin(integrationCredentials, eq(integrationCredentials.id, eventReceipts.credentialId))
    .where(
      and(
        eq(documents.userId, userId),
        eq(eventReceipts.userId, userId),
        eq(documents.source, eventReceipts.provider),
        eq(integrationCredentials.provider, credentialProviderOf(slug)),
        eq(documents.lastEmbedError, INBOUND_DAILY_EMBED_CAP_REASON),
        isNotNull(documents.embedFailedAt),
      ),
    );

  return {
    embedding: { dailyCap: INBOUND_DAILY_EMBED_CAP, cappedCount: capped?.count ?? 0 },
    kinds: rows.flatMap((row) =>
      // `IS NOT NULL` in the WHERE clause proves both; the select type cannot see it.
      row.rawKind && row.lastSeenAt
        ? [{ kind: row.rawKind, count: row.count, lastSeenAt: row.lastSeenAt.toISOString() }]
        : [],
    ),
  };
}
