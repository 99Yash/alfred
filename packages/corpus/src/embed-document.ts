import { embedMany, voyageInputPricePerMtokUsd } from "@alfred/ai/embeddings";
import { db } from "@alfred/db";
import { buildEmbedFailureSet, EMBED_SUCCESS_RESET } from "@alfred/db/helpers";
import { chunks, documents, type Document } from "@alfred/db/schemas";
import { and, desc, eq, isNull, notExists, sql } from "drizzle-orm";
import {
  isRecord,
  isValidPage,
  parseDocumentPages,
  parseDocumentPagesMixed,
} from "@alfred/contracts";
import { chunkPages, chunkText, type Chunk, type PageInput } from "./chunker";
import {
  capChunksForBudget,
  EMBED_COST_CAP_USD,
  maxTokensForPrice,
  type EmbedBudgetSlice,
} from "./embed-policy";
import { sha256 } from "./hash";

/**
 * Record an embed failure on the document row via the shared poison-pill guard
 * (`buildEmbedFailureSet` in `@alfred/db/helpers`): a per-input-permanent error
 * (400/413/422 — the input itself is un-embeddable) dead-letters the document
 * immediately; every other failure, including a systemic 4xx, rides the
 * wall-clock retry window regardless of how many sweeps hit it. `embedAttempts`
 * still counts every failure for diagnostics but no longer triggers
 * dead-lettering. Best-effort: the caller always rethrows the original error.
 *
 * Exported for the DB-backed poison-pill test; `embedDocument` is the only
 * production caller.
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

/**
 * The `.set(...)` payload that marks a document terminal for the sweep: the
 * row keeps its head chunks (still searchable) but `embed_failed_at` drops it
 * from `findUnembeddedDocumentIds`, and `last_embed_error` carries the reason.
 * Shared by the no-embeddable-content path and the cost-cap truncation path so
 * both write the identical marker shape.
 */
function embedTerminalSet(reason: string) {
  return {
    embedFailedAt: sql`COALESCE(${documents.embedFailedAt}, now())`,
    lastEmbedError: reason,
  };
}

/** Dead-letter a document that can never embed (no content, or fully cost-capped). */
async function markDocumentEmbedTerminal(documentId: string, reason: string): Promise<void> {
  await db().update(documents).set(embedTerminalSet(reason)).where(eq(documents.id, documentId));
}

/** The durable `last_embed_error` reason a cost-cap truncation leaves behind. */
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

/**
 * Chunk + embed a single document. Idempotent on the unique
 * `(document_id, position)` index — re-running for the same document
 * is a no-op unless the content hash changed (in which case we rewrite
 * the chunk row in place).
 *
 * Embeddings are written together with the rows: `embedMany` covers all
 * of a document's chunks, splitting into multiple Voyage calls when the
 * set exceeds Voyage's per-request limits (1000 inputs / 120k tokens).
 *
 * Cost policy: the $0.50 cap (`EMBED_COST_CAP_USD` in `./embed-policy`)
 * governs ONE call — the new-chunk set this invocation sends. A truncation
 * writes the fitting prefix, marks the document terminal for the sweep
 * (`embed_failed_at` + reason in `last_embed_error`), reports
 * `truncated: true`, and warns; it does not throw. The tail stays
 * un-embedded by decision, and an explicit re-index makes progress because
 * each call caps only chunks that do not match stored hashes.
 *
 * Failures here don't roll back the parent `documents` row — the doc is
 * still useful as a SQL-searchable artifact even if embedding failed.
 * Callers can use `findUnembeddedDocumentIds` to find docs that need a
 * (re-)embedding pass and call `indexDocument` for each (`retryPending`
 * folds that sweep).
 *
 * Concurrency: the persistence phase (UPSERT chunks, DELETE orphan tail,
 * and poison-pill reset) runs inside a single `db().transaction(...)` so
 * the SELECT → embed → UPSERT → DELETE chain cannot interleave a stale
 * snapshot delete. Per-document serialization is via the transaction's
 * snapshot — concurrent `indexDocument` calls for the same `documentId`
 * that shorten to different lengths are serialized by the transaction
 * rather than by a separate advisory lock.
 */
export interface IndexDocumentArgs {
  documentId: string;
  /** Voyage idempotency key forwarded for cost-attribution greppability. */
  idempotencyKey?: string;
  /**
   * Provider input price per million tokens, used to derive the per-call
   * token budget from `EMBED_COST_CAP_USD`. Defaults to the Voyage price
   * (`voyageInputPricePerMtokUsd`, env-overridable) — the one wiring point
   * that knows the provider price; tests and future providers inject a value
   * here instead of the policy importing one.
   */
  pricePerMtokUsd?: number;
}

export interface IndexDocumentResult {
  documentId: string;
  chunksWritten: number;
  chunksSkipped: number;
  /** True when nothing was written because the doc had no embeddable content. */
  empty: boolean;
  /**
   * True when the per-call cost cap truncated the new-chunk set. The written
   * prefix is searchable; the doc carries a terminal marker for the sweep and
   * `lastEmbedError` names the truncation.
   */
  truncated: boolean;
}

export async function indexDocument(args: IndexDocumentArgs): Promise<IndexDocumentResult> {
  const docRows = await db().select().from(documents).where(eq(documents.id, args.documentId));
  const doc = docRows[0];
  if (!doc) throw new Error(`[embed-document] not found: ${args.documentId}`);

  const pageInputs = extractPageInputs(doc);
  const splits = pageInputs ? chunkPages(pageInputs) : chunkText(doc.content);
  if (splits.length === 0) {
    // No embeddable content, and documents are immutable — this row would
    // otherwise be re-selected by the sweep on every tick. Dead-letter it.
    await markDocumentEmbedTerminal(doc.id, "no embeddable content (0 chunks)");
    return {
      documentId: doc.id,
      chunksWritten: 0,
      chunksSkipped: 0,
      empty: true,
      truncated: false,
    };
  }

  // Look up existing chunk rows to skip work when the content hashes
  // already match. We don't delete-and-rewrite — keeping ids stable
  // helps any future foreign-key references and lets the HNSW index
  // reuse warmed pages.
  // Include `metadata` so a re-extraction that changes only the page
  // (identical text, new page anchor) does not stay stale — see D6 design checkpoint.
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
    // No changed chunks, but still atomically clean orphan tails and poison-pill
    // state so a re-encode that shortens without changing retained hashes does
    // not leave stale searchable chunks.
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

  // Single owner for the $0.50 cap. The cap governs this invocation's
  // *new* chunks (`toEmbed`) after the existing-hash filter, not the total
  // `splits` and not the document lifetime. Capping `splits` would discard
  // tail chunks even when the embed bill is tiny (e.g. 1990 cached + 10 new
  // = 10 billable tokens, but 16M total). When the cap bites, the document
  // is marked terminal for the sweep below (durable truncation, not a silent
  // one); an explicit re-index still progresses because each call caps only
  // the chunks that do not already match stored hashes.
  const maxTokens = maxTokensForPrice(args.pricePerMtokUsd ?? voyageInputPricePerMtokUsd());
  const capped = capChunksForBudget(toEmbed, toEmbedHashes, maxTokens);
  const cappedChunks = capped.chunks;
  const cappedHashes = capped.hashes;
  if (capped.truncated) {
    // The caller-side observable for the pure cap: one warn with the counts,
    // plus the durable marker written on every truncation path below.
    console.warn(
      `[embed-document] cost cap hit for doc=${doc.id}: ${capped.total} tokens exceed the ${maxTokens}-token budget (cap $${EMBED_COST_CAP_USD}/call), embedding first ${capped.kept}/${toEmbed.length} new chunks`,
    );
  }
  if (cappedChunks.length === 0) {
    // Budget truncated everything (first chunk over cap). No vectors to embed
    // and no chunk rows would be written — without a marker the sweep would
    // re-select this doc forever, so dead-letter it with the reason.
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

  // Only the Voyage call (and validating its output) counts toward the embed
  // poison-pill guard. The upsert loop below is deliberately outside this
  // try: a DB write failure is a *persistence* error, not an embed failure —
  // the (billed) embedding succeeded — so it must not increment `embedAttempts`
  // or dead-letter a perfectly embeddable doc. It propagates untouched and the
  // sweep retries (no chunks written → still a candidate).
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
    // Count the failure so the sweep dead-letters a poison-pill doc instead of
    // re-embedding it forever, then rethrow so callers still log/handle it.
    try {
      await recordDocumentEmbedFailure(doc.id, err);
    } catch {
      // Best-effort bookkeeping — never mask the original embed error.
    }
    throw err;
  }

  // Persistence is atomic: UPSERT changed chunks, DELETE orphan tail, and
  // poison-pill reset commit together. This closes the interleaving where
  // T1 reads existing (10 rows), T2 reads existing (10 rows), T1 embeds 4
  // and deletes >=4, and T2's stale delete then operates on a stale snapshot.
  await db().transaction(async (tx) => {
    // Upsert every changed position in one round-trip. Conflict updates must
    // read from `excluded`: each row has different content, vector, and hash.
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
          metadata: chunk.page != null ? { page: chunk.page } : {},
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

    // Remove orphan tail rows from a previous re-extraction that produced more chunks.
    // Positions are dense 0..N-1, so any position >= splits.length is stale.
    if (existingChunks.length > splits.length) {
      await tx
        .delete(chunks)
        .where(and(eq(chunks.documentId, doc.id), sql`${chunks.position} >= ${splits.length}`));
    }

    // Terminal vs reset, decided once: a cost-capped write stamps the
    // truncation marker (same shape as `markDocumentEmbedTerminal`) so the
    // sweep drops the half-embedded doc instead of ignoring or re-selecting
    // it; a clean write clears any prior poison-pill streak now that the doc
    // embedded cleanly, so the wall-clock grace is per-failure-streak. Both
    // are gated on the pre-read row / cap result so an ordinary first-time
    // embed (the common case) skips the extra write.
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
 * Find documents with no chunks. Used by the post-ingest backfill in
 * m7c onwards (and by the m7b smoke test to confirm the embed pipeline
 * reached every ingested document).
 *
 * Cost-capped documents are excluded by the same `embed_failed_at` filter as
 * dead-lettered ones: a truncation stamps that marker, so a half-embedded
 * doc never re-enters the candidate set. An explicit `indexDocument` call
 * ignores the marker and remains the way to finish (or re-index) one.
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
  // Skip dead-lettered docs (permanent failure, attempt cap, or no embeddable
  // content) so a poison pill doesn't get re-selected on every sweep forever.
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

/**
 * Parse `documents.metadata.pages` via the shared contract helpers. The
 * canonical page shape is `ExtractedPdfPage.pageNumber` proven by
 * `parsePdfExtractionChildReply` (positive integer, dense 1..N) and
 * `chunks.metadata.page` checked by `isValidPage`. `documents.metadata` is
 * `unknown` jsonb with no static guarantee, so this boundary delegates to
 * `parseDocumentPages` / `parseDocumentPagesMixed` in `@alfred/contracts`
 * rather than hand-rolled `isRecord` checks.
 */
function extractPageInputs(doc: Pick<Document, "content" | "metadata">): PageInput[] | null {
  if (!isRecord(doc.metadata)) return null;
  const rawPages = doc.metadata.pages;
  if (!Array.isArray(rawPages) || rawPages.length === 0) return null;

  // Try offset-encoded pages first — the canonical writer path.
  const offsetPages = parseDocumentPages(rawPages);
  if (offsetPages) {
    const out: PageInput[] = [];
    for (const entry of offsetPages) {
      out.push({ page: entry.page, text: doc.content.slice(entry.start, entry.end) });
    }
    return out.length > 0 ? out : null;
  }

  // Legacy fallback: mixed union of {page, text} and {page, start, end}
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

/**
 * Read the proven page anchor off stored chunk metadata. Shared with
 * `search`, so every reader of `chunks.metadata.page` applies the same
 * validity rule (`isValidPage`) and a hit can never claim an unproven page.
 */
export function extractPageFromMetadata(raw: unknown): number | null {
  if (!isRecord(raw)) return null;
  const page = raw.page;
  return isValidPage(page) ? page : null;
}
