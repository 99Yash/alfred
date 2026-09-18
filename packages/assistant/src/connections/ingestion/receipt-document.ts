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
 * The corpus document of one receipt is keyed `(userId, source = the event
 * source, sourceId = the receipt id)`. This file is the one place that key is
 * spelled: the writer below inserts under it, {@link receiptDocumentJoin} is
 * the same key as a SQL join for the inventory and the backfill, and
 * {@link readReceiptDocument} reads it back for a run's `<trigger_event>`.
 * A re-key of the document changes these three and nothing else.
 */
export function receiptDocumentKey(receipt: {
  id: string;
  userId: string;
  provider: InboundEventSource;
}): Pick<Document, "userId" | "source" | "sourceId"> {
  return { userId: receipt.userId, source: receipt.provider, sourceId: receipt.id };
}

/** {@link receiptDocumentKey} as the join from an `eventReceipts` row to its document. */
export function receiptDocumentJoin(): SQL | undefined {
  return and(
    eq(documents.userId, eventReceipts.userId),
    eq(documents.source, eventReceipts.provider),
    eq(documents.sourceId, eventReceipts.id),
  );
}

/** The display fields of a receipt's document. `raw` is the stored payload and is never selected. */
export type ReceiptDocument = Pick<
  Document,
  "title" | "content" | "url" | "authoredAt" | "metadata"
>;

/** The document the receive path wrote for one receipt, or `null` when none exists. */
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

/** The receipt facts {@link prepareReceiptProjection} reads: raw/typed kind and the owning user. */
export type ReceiptProjectionFacts = Pick<EventReceipt, "userId" | "eventType" | "rawKind"> & {
  readonly provider: InboundEventSource;
};

/**
 * The normalized receipt inputs the writer consumes. Opaque: only
 * {@link prepareReceiptProjection} constructs one, so a call site cannot hand
 * the writer a `kind` or another user's zone.
 *
 * The brand is type-only (the intersection below), matching `IanaTimezone`,
 * `LocalDateKey`, and the other brands: there is no runtime symbol to
 * reference, so a mint cannot accidentally emit one.
 */
export type ReceiptProjection = {
  readonly provider: InboundEventSource;
  readonly userId: string;
  readonly kind: string;
  readonly timezone: IanaTimezone;
} & { readonly [receiptProjectionBrand]: true };

/**
 * The kind precedence the backfill used to spell inline:
 * `rawKind ?? parseEventTypeName(provider, eventType) ?? eventType`. A typed row
 * stores `eventTypeName(source, type)` (so `parseEventTypeName` recovers `type`)
 * and a raw row carries its provider kind in `rawKind`, which wins the chain.
 */
function deriveReceiptKind(facts: ReceiptProjectionFacts): string {
  return facts.rawKind ?? parseEventTypeName(facts.provider, facts.eventType) ?? facts.eventType;
}

/**
 * The brand's only mint, shared by {@link prepareReceiptProjection} and the
 * {@link receiptProjectionBatch} rows. The zone is resolved by the caller, so
 * every construction path still runs `resolveTimezone` behind this module.
 */
function mintReceiptProjection(
  facts: ReceiptProjectionFacts,
  timezone: IanaTimezone,
): ReceiptProjection {
  // SAFETY: this function is the brand's only mint; the type-only brand makes a
  // hand-built { kind, timezone } object a type error at every other call site.
  return {
    provider: facts.provider,
    userId: facts.userId,
    kind: deriveReceiptKind(facts),
    timezone,
  } as ReceiptProjection;
}

/**
 * Derive the provider kind and resolve the user's zone for one receipt. MUST run
 * before any transaction opens: `resolveTimezone` is a pooled settings read, and
 * holding a transaction connection through it can exhaust the pool under
 * concurrent receipt writes.
 *
 * This is the receive path: one receipt, one resolve. The backfill, which walks
 * many receipts, uses {@link receiptProjectionBatch} instead.
 */
export async function prepareReceiptProjection(
  facts: ReceiptProjectionFacts,
): Promise<ReceiptProjection> {
  const timezone = await resolveTimezone(facts.userId);

  return mintReceiptProjection(facts, timezone);
}

/**
 * A per-batch zone memo. Not global and not persistent: it lives only as long as
 * the caller's batch. The first `prepare` for a user resolves their zone; later
 * `prepare` calls for the same user reuse it. A failed resolution is not cached,
 * so the next row retries — the per-row failure escape is kept.
 *
 * Create one batcher per batch, not per row: calling `receiptProjectionBatch()`
 * inside a loop restores the repeated `resolveTimezone` this seam removes.
 */
export interface ReceiptProjectionBatch {
  prepare(facts: ReceiptProjectionFacts): Promise<ReceiptProjection>;
}

/**
 * Open a batch-local zone memo. The memo stores only fulfilled zones, so one
 * user's failed resolve leaves the next row free to retry. A user's zone is
 * captured at their first `prepare` and reused for the rest of the batch, until
 * {@link writeReceiptDocument} stamps `admittedAt`, so the memo holds a zone a
 * user may have changed mid-batch. Staleness is bounded by the wall-clock span
 * from a user's first `prepare` to their last admission in one batch; the
 * backfill loop is serial and capped, but not time-boxed, so no numeric bound is
 * claimed. Crossing local midnight is safe: the writer computes
 * `inZone(zone).dayBounds(admittedAt)`, so the cap day is the admitted day.
 */
export function receiptProjectionBatch(): ReceiptProjectionBatch {
  const zones = new Map<string, IanaTimezone>();

  return {
    async prepare(facts: ReceiptProjectionFacts): Promise<ReceiptProjection> {
      let timezone = zones.get(facts.userId);

      if (timezone === undefined) {
        timezone = await resolveTimezone(facts.userId);
        zones.set(facts.userId, timezone);
      }

      return mintReceiptProjection(facts, timezone);
    },
  };
}

/** The receipt identity a document is written under: the row id, payload, delivery time, and account. */
export type ReceiptDocumentIdentity = Pick<EventReceipt, "id" | "payload" | "deliveredAt"> & {
  readonly accountId: string;
};

/**
 * Called for a new receipt or a stored receipt without a document. The receipt's
 * unique key proves document identity; rollback preserves the pair on failure.
 * The per-user/source lock serializes admission across concurrent deliveries.
 * No provider or embedding call runs on this path; the existing sweep indexes it.
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
