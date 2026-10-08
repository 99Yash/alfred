import { embedMany, voyageInputPricePerMtokUsd } from "@alfred/ai/embeddings";
import { db } from "@alfred/db";
import { buildEmbedFailureSet, EMBED_SUCCESS_RESET } from "@alfred/db/helpers";
import { chunks, documents, type Document } from "@alfred/db/schemas";
import { and, desc, eq, isNull, notExists, sql } from "drizzle-orm";
import { isRecord, parseDocumentPages, parseDocumentPagesMixed } from "@alfred/contracts";
import { chunkMetadata, extractPageFromMetadata } from "./chunk-metadata";
import { chunkPages, chunkText, type Chunk, type PageInput } from "./chunker";
import {
  capChunksForBudget,
  EMBED_COST_CAP_USD,
  maxTokensForPrice,
  type EmbedBudgetSlice,
} from "./embed-policy";
import { sha256 } from "./hash";

/**
 * Record an embed failure (`buildEmbedFailureSet`). A 400/413/422 dead-letters
 * the document now; other errors retry until the time window ends.
 * Exported for a test.
 */
export async function recordDocumentEmbedFailure(documentId: string, err: unknown): Promise<void> {
  await db()
    .update(documents)
    .set(
      buildEmbedFailureSet(
        {
          attempts: documents.embedAttempts,
          firstFailedAt: documents.embedFirstFailedAt,
          failedAt: documents.embedFailedAt,
        },
        err,
      ),
    )
    .where(eq(documents.id, documentId));
}

/** Take the document out of the sweep. Chunks already written stay searchable. */
function embedTerminalSet(reason: string) {
  return {
    embedFailedAt: sql`COALESCE(${documents.embedFailedAt}, now())`,
    lastEmbedError: reason,
  };
}

/** Dead-letter a document that can never embed. */
async function markDocumentEmbedTerminal(documentId: string, reason: string): Promise<void> {
  await db().update(documents).set(embedTerminalSet(reason)).where(eq(documents.id, documentId));
}

/** `last_embed_error` text for a cost-cap truncation. */
function costCapTruncationError(
  capped: EmbedBudgetSlice,
  newChunkCount: number,
  maxTokens: number,
): string {
  return (
    `cost cap: embedded ${capped.kept} of ${newChunkCount} new chunks ` +
    `(${capped.total} tokens exceed the ${maxTokens}-token per-call budget)`
  );
}

export interface IndexDocumentArgs {
  documentId: string;
  /** Forwarded to Voyage so the cost is easy to trace. */
  idempotencyKey?: string;
  /** Price per million input tokens, to size the per-call budget. Defaults to the Voyage price. */
  pricePerMtokUsd?: number;
}

export interface IndexDocumentResult {
  documentId: string;
  chunksWritten: number;
  chunksSkipped: number;
  /** The document had no embeddable content. */
  empty: boolean;
  /** The cost cap cut the new chunks. The written prefix is searchable; the sweep skips the doc. */
  truncated: boolean;
}

/**
 * Chunk and embed one document. Skips chunks whose hash and page are unchanged.
 * The $0.50 cap (`EMBED_COST_CAP_USD`) covers only the new chunks of this call,
 * so a later explicit re-index still makes progress. A failure leaves the
 * `documents` row in place; `retryPending` sweeps it again.
 */
export async function indexDocument(args: IndexDocumentArgs): Promise<IndexDocumentResult> {
  const docRows = await db().select().from(documents).where(eq(documents.id, args.documentId));
  const doc = docRows[0];

  if (!doc) throw new Error(`[embed-document] not found: ${args.documentId}`);

  const pageInputs = extractPageInputs(doc);
  const splits = pageInputs ? chunkPages(pageInputs) : chunkText(doc.content);

  if (splits.length === 0) {
    // Documents are immutable, so the sweep would pick this row again forever.
    await markDocumentEmbedTerminal(doc.id, "no embeddable content (0 chunks)");

    return {
      documentId: doc.id,
      chunksWritten: 0,
      chunksSkipped: 0,
      empty: true,
      truncated: false,
    };
  }

  // Update in place to keep chunk ids stable. Compare the page too: a
  // re-extraction can move identical text to a new page.
  const existingChunks = await db()
    .select({
      position: chunks.position,
      contentHash: chunks.contentHash,
      metadata: chunks.metadata,
    })
    .from(chunks)
    .where(eq(chunks.documentId, doc.id));

  const existingByPosition = new Map(
    existingChunks.map((c) => [
      c.position,
      { hash: c.contentHash, page: extractPageFromMetadata(c.metadata) },
    ]),
  );

  const toEmbed: Chunk[] = [];
  const toEmbedHashes: string[] = [];

  for (const chunk of splits) {
    const hash = sha256(chunk.content);
    const existing = existingByPosition.get(chunk.position);

    if (existing && existing.hash === hash && existing.page === (chunk.page ?? null)) continue;
    toEmbed.push(chunk);
    toEmbedHashes.push(hash);
  }

  const skipped = splits.length - toEmbed.length;

  if (toEmbed.length === 0) {
    // Nothing to embed, but a shorter document still leaves a stale tail to delete.
    const needsOrphanDelete = existingChunks.length > splits.length;

    const needsReset =
      doc.embedAttempts > 0 || doc.embedFailedAt !== null || doc.embedFirstFailedAt !== null;

    if (needsOrphanDelete || needsReset) {
      await db().transaction(async (tx) => {
        if (needsOrphanDelete) {
          await tx
            .delete(chunks)
            .where(and(eq(chunks.documentId, doc.id), sql`${chunks.position} >= ${splits.length}`));
        }

        if (needsReset) {
          await tx.update(documents).set(EMBED_SUCCESS_RESET).where(eq(documents.id, doc.id));
        }
      });
    }

    return {
      documentId: doc.id,
      chunksWritten: 0,
      chunksSkipped: skipped,
      empty: false,
      truncated: false,
    };
  }

  // Cap only the new chunks. Capping all `splits` would cut the tail even when
  // most chunks are cached and the bill is tiny.
  const maxTokens = maxTokensForPrice(args.pricePerMtokUsd ?? voyageInputPricePerMtokUsd());
  const capped = capChunksForBudget(toEmbed, toEmbedHashes, maxTokens);
  const cappedChunks = capped.chunks;
  const cappedHashes = capped.hashes;

  if (capped.truncated) {
    console.warn(
      `[embed-document] cost cap hit for doc=${doc.id}: ${capped.total} tokens exceed the ${maxTokens}-token budget (cap $${EMBED_COST_CAP_USD}/call), embedding first ${capped.kept}/${toEmbed.length} new chunks`,
    );
  }

  if (cappedChunks.length === 0) {
    // The first chunk is over the cap. Without a marker the sweep picks this doc forever.
    await markDocumentEmbedTerminal(
      doc.id,
      costCapTruncationError(capped, toEmbed.length, maxTokens),
    );

    return {
      documentId: doc.id,
      chunksWritten: 0,
      chunksSkipped: skipped,
      empty: false,
      truncated: true,
    };
  }

  // Only the embed call counts as an embed failure. A DB write error below must
  // not dead-letter a document that embedded correctly.
  let vectors: number[][];

  try {
    vectors = await embedMany(
      cappedChunks.map((c) => c.content),
      {
        userId: doc.userId,
        inputType: "document",
        idempotencyKey: args.idempotencyKey ?? `embed-doc:${doc.id}`,
      },
    );

    if (vectors.length !== cappedChunks.length) {
      throw new Error(
        `[embed-document] vector count mismatch: got ${vectors.length} for ${cappedChunks.length} chunks`,
      );
    }
  } catch (err) {
    try {
      await recordDocumentEmbedFailure(doc.id, err);
    } catch {
      // Never hide the original embed error.
    }

    throw err;
  }

  // Upsert, tail delete, and failure reset commit together, so two concurrent
  // runs cannot delete from a stale snapshot.
  await db().transaction(async (tx) => {
    // Read from `excluded`: each row has its own content, vector, and hash.
    await tx
      .insert(chunks)
      .values(
        cappedChunks.map((chunk, i) => ({
          documentId: doc.id,
          userId: doc.userId,
          position: chunk.position,
          content: chunk.content,
          embedding: vectors[i]!,
          tokenCount: chunk.tokenCount,
          contentHash: cappedHashes[i]!,
          metadata: chunkMetadata(chunk.page ?? null),
        })),
      )
      .onConflictDoUpdate({
        target: [chunks.documentId, chunks.position],
        set: {
          content: sql`excluded.content`,
          embedding: sql`excluded.embedding`,
          tokenCount: sql`excluded.token_count`,
          contentHash: sql`excluded.content_hash`,
          metadata: sql`excluded.metadata`,
          updatedAt: new Date(),
        },
      });

    // Positions are dense 0..N-1, so any position >= splits.length is stale.
    if (existingChunks.length > splits.length) {
      await tx
        .delete(chunks)
        .where(and(eq(chunks.documentId, doc.id), sql`${chunks.position} >= ${splits.length}`));
    }

    // A capped write takes the doc out of the sweep. A clean write clears a
    // past failure streak. A first clean embed writes neither.
    if (capped.truncated) {
      await tx
        .update(documents)
        .set(embedTerminalSet(costCapTruncationError(capped, toEmbed.length, maxTokens)))
        .where(eq(documents.id, doc.id));
    } else if (
      doc.embedAttempts > 0 ||
      doc.embedFailedAt !== null ||
      doc.embedFirstFailedAt !== null
    ) {
      await tx.update(documents).set(EMBED_SUCCESS_RESET).where(eq(documents.id, doc.id));
    }
  });

  return {
    documentId: doc.id,
    chunksWritten: cappedChunks.length,
    chunksSkipped: skipped,
    empty: false,
    truncated: capped.truncated,
  };
}

/**
 * Documents with no chunks and no `embed_failed_at`, newest first.
 * A direct `indexDocument` call ignores the marker and can finish a capped doc.
 */
export async function findUnembeddedDocumentIds(opts: {
  userId?: string;
  source?: Document["source"];
  limit?: number;
}): Promise<string[]> {
  const limit = opts.limit ?? 100;

  const noChunksFilter = notExists(
    db()
      .select({ one: sql`1` })
      .from(chunks)
      .where(eq(chunks.documentId, documents.id)),
  );

  const filters = [noChunksFilter, isNull(documents.embedFailedAt)];

  if (opts.userId) filters.push(eq(documents.userId, opts.userId));

  if (opts.source) filters.push(eq(documents.source, opts.source));

  const rows = await db()
    .select({ id: documents.id })
    .from(documents)
    .where(and(...filters))
    .orderBy(desc(documents.ingestedAt))
    .limit(limit);

  return rows.map((r) => r.id);
}

/** Page texts from `documents.metadata.pages`, or null when the metadata has no valid pages. */
function extractPageInputs(doc: Pick<Document, "content" | "metadata">): PageInput[] | null {
  if (!isRecord(doc.metadata)) return null;
  const rawPages = doc.metadata.pages;

  if (!Array.isArray(rawPages) || rawPages.length === 0) return null;

  // Offset pages are what current writers store.
  const offsetPages = parseDocumentPages(rawPages);

  if (offsetPages) {
    const out: PageInput[] = [];

    for (const entry of offsetPages) {
      out.push({ page: entry.page, text: doc.content.slice(entry.start, entry.end) });
    }

    return out.length > 0 ? out : null;
  }

  // Older rows can mix {page, text} and {page, start, end}.
  const mixedPages = parseDocumentPagesMixed(rawPages);

  if (!mixedPages) return null;
  const out: PageInput[] = [];

  for (const entry of mixedPages) {
    if ("text" in entry) {
      out.push({ page: entry.page, text: entry.text });
    } else {
      out.push({ page: entry.page, text: doc.content.slice(entry.start, entry.end) });
    }
  }

  return out.length > 0 ? out : null;
}
