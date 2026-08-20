import { embedMany } from "@alfred/ai/embeddings";
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
import { createHash } from "node:crypto";
import { chunkPages, chunkText, type Chunk, type PageInput } from "./chunker";

const EMBED_COST_CAP_USD = 0.5;
const VOYAGE_INPUT_PER_MTOK = 0.06; // voyage-3.5, the default at `ai/src/embeddings.ts:24`
const MAX_EMBED_TOKENS_PER_DOC = Math.floor(
  (EMBED_COST_CAP_USD / VOYAGE_INPUT_PER_MTOK) * 1_000_000,
);

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

/** Dead-letter a document that can never produce chunks (no embeddable content). */
async function markDocumentEmbedTerminal(documentId: string, reason: string): Promise<void> {
  await db()
    .update(documents)
    .set({
      embedFailedAt: sql`COALESCE(${documents.embedFailedAt}, now())`,
      lastEmbedError: reason,
    })
    .where(eq(documents.id, documentId));
}

/**
 * Single owner for the $0.50 embed budget. Truncates `chunks` in place to
 * the first N that fit `MAX_EMBED_TOKENS_PER_DOC` and keeps `hashes` in
 * sync. The policy is truncate-and-warn, not dead-letter, except when
 * even the first chunk exceeds the cap (handled by the caller).
 */
function capChunksForBudget(
  chunks: Chunk[],
  hashes: string[],
  docId: string,
): { truncated: boolean; kept: number; total: number } {
  const total = chunks.reduce((sum, c) => sum + c.tokenCount, 0);
  if (total <= MAX_EMBED_TOKENS_PER_DOC) return { truncated: false, kept: chunks.length, total };
  let used = 0;
  let keep = 0;
  for (const c of chunks) {
    if (used + c.tokenCount > MAX_EMBED_TOKENS_PER_DOC) break;
    used += c.tokenCount;
    keep++;
  }
  console.warn(
    `[embed-document] cost cap hit for doc=${docId}: ${total} tokens > ${MAX_EMBED_TOKENS_PER_DOC} (cap $${EMBED_COST_CAP_USD}), embedding first ${keep}/${chunks.length} chunks`,
  );
  chunks.splice(keep);
  hashes.splice(keep);
  return { truncated: true, kept: keep, total };
}

/**
 * Chunk + embed a single document. Idempotent on the unique
 * `(document_id, position)` index — re-running for the same document
 * is a no-op unless the content hash changed (in which case we rewrite
 * the chunk row in place).
 *
 * Embeddings are written together with the rows: one Voyage call per
 * document covers all its chunks (Voyage allows up to 1000 inputs per
 * batch; emails rarely exceed a handful of chunks).
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
}

export interface IndexDocumentResult {
  documentId: string;
  chunksWritten: number;
  chunksSkipped: number;
  /** True when nothing was written because the doc had no embeddable content. */
  empty: boolean;
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
    return { documentId: doc.id, chunksWritten: 0, chunksSkipped: 0, empty: true };
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
    return { documentId: doc.id, chunksWritten: 0, chunksSkipped: skipped, empty: false };
  }

  // Single owner for the $0.50 cap. Apply to the *new* chunks (`toEmbed`)
  // after the existing-hash filter, not to the total `splits`. Capping
  // `splits` would discard tail chunks even when the embed bill is tiny
  // (e.g. 1990 cached + 10 new = 10 billable tokens, but 16M total).
  // Truncation is the policy — we keep the first N chunks that fit the
  // budget and warn; only a doc whose *first* chunk exceeds the cap is
  // dead-lettered (never happens at $0.50 / $0.06 Mtok).
  capChunksForBudget(toEmbed, toEmbedHashes, doc.id);
  if (toEmbed.length === 0 && splits.length > 0) {
    await markDocumentEmbedTerminal(doc.id, "exceeds embedding cost cap ($0.50)");
    return { documentId: doc.id, chunksWritten: 0, chunksSkipped: skipped, empty: true };
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
      toEmbed.map((c) => c.content),
      {
        userId: doc.userId,
        inputType: "document",
        idempotencyKey: args.idempotencyKey ?? `embed-doc:${doc.id}`,
      },
    );
    if (vectors.length !== toEmbed.length) {
      throw new Error(
        `[embed-document] vector count mismatch: got ${vectors.length} for ${toEmbed.length} chunks`,
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
        toEmbed.map((chunk, i) => ({
          documentId: doc.id,
          userId: doc.userId,
          position: chunk.position,
          content: chunk.content,
          embedding: vectors[i]!,
          tokenCount: chunk.tokenCount,
          contentHash: toEmbedHashes[i]!,
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

    // Clear any prior poison-pill streak now that the doc embedded cleanly, so the
    // wall-clock grace is per-failure-streak and a resurrected doc doesn't carry a
    // stale `embed_first_failed_at` into its next blip. Gated on the pre-read row
    // so an ordinary first-time embed (the common case) skips the extra write.
    if (doc.embedAttempts > 0 || doc.embedFailedAt !== null || doc.embedFirstFailedAt !== null) {
      await tx.update(documents).set(EMBED_SUCCESS_RESET).where(eq(documents.id, doc.id));
    }
  });

  return {
    documentId: doc.id,
    chunksWritten: toEmbed.length,
    chunksSkipped: skipped,
    empty: false,
  };
}

/**
 * Find documents with no chunks. Used by the post-ingest backfill in
 * m7c onwards (and by the m7b smoke test to confirm the embed pipeline
 * reached every ingested document).
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

function sha256(input: string): string {
  return createHash("sha256").update(input).digest("hex");
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

function extractPageFromMetadata(raw: unknown): number | null {
  if (!isRecord(raw)) return null;
  const page = raw.page;
  return isValidPage(page) ? page : null;
}
