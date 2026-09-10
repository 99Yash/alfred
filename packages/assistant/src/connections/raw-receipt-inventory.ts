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

/**
 * The grouped raw kinds of one scope: each provider kind the registry does not
 * name, how many verified deliveries carried it, and when the last one arrived,
 * newest first. The one derivation of "kinds seen"; the two readers below
 * differ only in the scope they pass, so they cannot disagree on the grouping.
 */
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
 * The raw receipt inventory of one integration for one user (ADR-0097 item 9).
 * This is how a new provider resource becomes visible the day it starts to
 * arrive, on the integration detail page.
 *
 * The rows are scoped through the credential that owns them, not through
 * `event_receipts.provider`: an integration slug and an event-source slug are
 * different spaces (ADR-0097 item 5), and the credential join is the one link
 * the receipt itself records. A Google slug therefore reads an empty inventory,
 * because no raw receipt is ever attributed to a Google credential.
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
      // `IS NOT NULL` in the WHERE clause proves both; the select type cannot see it.
      row.rawKind && row.lastSeenAt
        ? [{ kind: row.rawKind, count: row.count, lastSeenAt: row.lastSeenAt.toISOString() }]
        : [],
    ),
  };
}

/** Bound on the kinds one source lists; a provider's kind space is a few dozen at most. */
const SEEN_RAW_KINDS_LIMIT = 100;

/**
 * The raw kinds one event source has delivered to this user, newest first
 * (#990). The revision service reads it to refuse a raw trigger on a kind the
 * source has never sent, and to name the kinds it has, so authoring can
 * self-correct. The scope is `event_receipts.provider`, unlike the inventory
 * above: a trigger's `source` is an event-source slug, so here the two spaces
 * do not need the credential provider to meet.
 */
export async function seenRawKinds(userId: string, source: InboundEventSource): Promise<string[]> {
  const rows = await rawKindGroups(
    and(eq(eventReceipts.userId, userId), eq(eventReceipts.provider, source)),
  ).limit(SEEN_RAW_KINDS_LIMIT);

  // `IS NOT NULL` in the WHERE clause proves it; the select type cannot see it.
  return rows.flatMap((row) => (row.rawKind ? [row.rawKind] : []));
}
