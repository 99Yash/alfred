import type { IanaTimezone, InboundEventSource } from "@alfred/contracts";
import { sha256 } from "@alfred/corpus";
import type { DbTransaction } from "@alfred/db";
import { documents, type EventReceipt } from "@alfred/db/schemas";
import { and, count, eq, gte, lt, sql } from "drizzle-orm";
import { inZone } from "@alfred/assistant/time";
import { INBOUND_SOURCES } from "../ingress";
import { INBOUND_DAILY_EMBED_CAP, INBOUND_DAILY_EMBED_CAP_REASON } from "../receipt-corpus-policy";

/**
 * Called for a new receipt or a stored receipt without a document. The receipt's
 * unique key proves document identity; rollback preserves the pair on failure.
 * The per-user/source lock serializes admission across concurrent deliveries.
 * No provider or embedding call runs on this path; the existing sweep indexes it.
 */
export async function writeReceiptDocument(
  tx: DbTransaction,
  receipt: Pick<EventReceipt, "id" | "userId" | "payload" | "deliveredAt"> & {
    provider: InboundEventSource;
    kind: string;
    accountId: string;
  },
  timezone: IanaTimezone,
): Promise<void> {
  const description = INBOUND_SOURCES[receipt.provider].describe(receipt.kind, receipt.payload);
  await tx.execute(
    sql`select pg_advisory_xact_lock(hashtextextended(${`receipt-corpus:${receipt.userId}:${receipt.provider}`}, 0))`,
  );
  const admittedAt = new Date();
  const { start, end } = inZone(timezone).dayBounds(admittedAt);
  const [usage] = await tx
    .select({ count: count() })
    .from(documents)
    .where(
      and(
        eq(documents.userId, receipt.userId),
        eq(documents.source, receipt.provider),
        gte(documents.ingestedAt, start),
        lt(documents.ingestedAt, end),
      ),
    );
  const capped = (usage?.count ?? 0) >= INBOUND_DAILY_EMBED_CAP;
  await tx
    .insert(documents)
    .values({
      userId: receipt.userId,
      source: receipt.provider,
      sourceId: receipt.id,
      accountId: receipt.accountId,
      title: description.title,
      content: description.body,
      contentHash: sha256(description.body),
      raw: receipt.payload,
      url: description.url,
      authoredAt: receipt.deliveredAt,
      ingestedAt: admittedAt,
      metadata: { kind: receipt.kind, summary: description.summary },
      ...(capped
        ? { embedFailedAt: admittedAt, lastEmbedError: INBOUND_DAILY_EMBED_CAP_REASON }
        : {}),
    })
    .onConflictDoNothing({ target: [documents.userId, documents.source, documents.sourceId] });
}
