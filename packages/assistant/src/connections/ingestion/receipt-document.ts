import { parseEventTypeName, type IanaTimezone, type InboundEventSource } from "@alfred/contracts";
import { sha256 } from "@alfred/corpus";
import { db, type DbTransaction } from "@alfred/db";
import { documents, eventReceipts, type Document, type EventReceipt } from "@alfred/db/schemas";
import { and, count, eq, gte, lt, sql, type SQL } from "drizzle-orm";
import { resolveTimezone } from "@alfred/assistant/settings";
import { inZone } from "@alfred/assistant/time";
import { INBOUND_SOURCES } from "../ingress";
import { INBOUND_DAILY_EMBED_CAP, INBOUND_DAILY_EMBED_CAP_REASON } from "../receipt-corpus-policy";

/**
 * Corpus document key for one receipt: `(userId, source, sourceId = receipt id)`. The only place it
 * is spelled.
 */
export function receiptDocumentKey(receipt: {
  id: string;
  userId: string;
  provider: InboundEventSource;
}): Pick<Document, "userId" | "source" | "sourceId"> {
  return { userId: receipt.userId, source: receipt.provider, sourceId: receipt.id };
}

/** {@link receiptDocumentKey} as a join from `eventReceipts` to `documents`. */
export function receiptDocumentJoin(): SQL | undefined {
  return and(
    eq(documents.userId, eventReceipts.userId),
    eq(documents.source, eventReceipts.provider),
    eq(documents.sourceId, eventReceipts.id),
  );
}

/** Display fields of a receipt's document. Never selects `raw`. */
export type ReceiptDocument = Pick<
  Document,
  "title" | "content" | "url" | "authoredAt" | "metadata"
>;

/** The receipt's document, or `null`. */
export async function readReceiptDocument(receipt: {
  id: string;
  userId: string;
  provider: InboundEventSource;
}): Promise<ReceiptDocument | null> {
  const key = receiptDocumentKey(receipt);

  const rows = await db()
    .select({
      title: documents.title,
      content: documents.content,
      url: documents.url,
      authoredAt: documents.authoredAt,
      metadata: documents.metadata,
    })
    .from(documents)
    .where(
      and(
        eq(documents.userId, key.userId),
        eq(documents.source, key.source),
        eq(documents.sourceId, key.sourceId),
      ),
    )
    .limit(1);

  return rows[0] ?? null;
}

declare const receiptProjectionBrand: unique symbol;

export type ReceiptProjectionFacts = Pick<EventReceipt, "userId" | "eventType" | "rawKind"> & {
  readonly provider: InboundEventSource;
};

/** Writer input. Branded (type-only), so only {@link prepareReceiptProjection} can build one. */
export type ReceiptProjection = {
  readonly provider: InboundEventSource;
  readonly userId: string;
  readonly kind: string;
  readonly timezone: IanaTimezone;
} & { readonly [receiptProjectionBrand]: true };

/**
 * Derive the kind and resolve the user's zone. Run it before any transaction opens:
 * `resolveTimezone` uses a pooled connection, and holding a transaction through it can exhaust the
 * pool. Kind: `rawKind`, else the parsed typed name, else `eventType`.
 */
export async function prepareReceiptProjection(
  facts: ReceiptProjectionFacts,
): Promise<ReceiptProjection> {
  const kind =
    facts.rawKind ?? parseEventTypeName(facts.provider, facts.eventType) ?? facts.eventType;

  const timezone = await resolveTimezone(facts.userId);

  // SAFETY: the brand's only mint.
  return {
    provider: facts.provider,
    userId: facts.userId,
    kind,
    timezone,
  } as ReceiptProjection;
}

export type ReceiptDocumentIdentity = Pick<EventReceipt, "id" | "payload" | "deliveredAt"> & {
  readonly accountId: string;
};

/**
 * Write the corpus document for a receipt, inside the receipt's transaction. A per-user, per-source
 * advisory lock serializes the daily embed cap check. No provider or embed call here; the sweep
 * indexes later.
 */
export async function writeReceiptDocument(
  tx: DbTransaction,
  projection: ReceiptProjection,
  identity: ReceiptDocumentIdentity,
): Promise<void> {
  const { provider, userId, kind, timezone } = projection;
  const description = INBOUND_SOURCES[provider].describe(kind, identity.payload);
  await tx.execute(
    sql`select pg_advisory_xact_lock(hashtextextended(${`receipt-corpus:${userId}:${provider}`}, 0))`,
  );
  const admittedAt = new Date();
  const { start, end } = inZone(timezone).dayBounds(admittedAt);

  const [usage] = await tx
    .select({ count: count() })
    .from(documents)
    .where(
      and(
        eq(documents.userId, userId),
        eq(documents.source, provider),
        gte(documents.ingestedAt, start),
        lt(documents.ingestedAt, end),
      ),
    );

  const capped = (usage?.count ?? 0) >= INBOUND_DAILY_EMBED_CAP;
  await tx
    .insert(documents)
    .values({
      ...receiptDocumentKey({ id: identity.id, userId, provider }),
      accountId: identity.accountId,
      title: description.title,
      content: description.body,
      contentHash: sha256(description.body),
      raw: identity.payload,
      url: description.url,
      authoredAt: identity.deliveredAt,
      ingestedAt: admittedAt,
      metadata: { kind, summary: description.summary },
      ...(capped
        ? { embedFailedAt: admittedAt, lastEmbedError: INBOUND_DAILY_EMBED_CAP_REASON }
        : {}),
    })
    .onConflictDoNothing({ target: [documents.userId, documents.source, documents.sourceId] });
}
