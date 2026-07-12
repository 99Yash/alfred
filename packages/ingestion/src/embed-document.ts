import { embedMany } from "@alfred/ai/embeddings";
import { isHttpError, redactSecrets, toMessage } from "@alfred/contracts";
import { db } from "@alfred/db";
import { chunks, documents } from "@alfred/db/schemas";
import { and, desc, eq, isNull, notExists, sql } from "drizzle-orm";
import { createHash } from "node:crypto";
import { chunkText, type Chunk } from "./chunker";

/**
 * How long a *transient* embed failure (a Voyage 5xx/429, a network blip, a
 * whole-provider outage) is tolerated before the document is dead-lettered.
 * Gated on the wall-clock age of the first failure, NOT an attempt count: the
 * sweep runs every 5 minutes, so a small attempt cap would be exhausted by a
 * ~25-minute outage and permanently drop the entire pending backlog (silent
 * data loss). A full day gives the provider time to recover while still
 * terminating the `embed-doc:` retry storm for a genuinely un-embeddable doc.
 * A permanent error (4xx≠429) or an empty doc dead-letters immediately.
 */
export const EMBED_RETRY_WINDOW_HOURS = 24;

/** Cap the persisted failure message; `HttpError` bodies are already bounded + redacted. */
const MAX_EMBED_ERROR_CHARS = 500;

/**
 * Record an embed failure on the document row. A permanent error dead-letters
 * it (via `embedFailedAt`) immediately; a transient error is retried by the
 * sweep until it has persisted past `EMBED_RETRY_WINDOW_HOURS`. `embedAttempts`
 * still counts every failure for diagnostics but no longer triggers
 * dead-lettering. Best-effort: the caller always rethrows the original error.
 *
 * Exported for the DB-backed poison-pill test; `embedDocument` is the only
 * production caller.
 */
export async function recordDocumentEmbedFailure(documentId: string, err: unknown): Promise<void> {
  // A 4xx (that isn't 429) means the input itself is unacceptable to Voyage —
  // retrying can never succeed, so give up now. A transient failure instead
  // rides the wall-clock window: a provider outage that resolves inside a day
  // must not dead-letter anything, no matter how many sweeps hit it meanwhile.
  const permanent = isHttpError(err) && !err.retryable;
  await db()
    .update(documents)
    .set({
      embedAttempts: sql`${documents.embedAttempts} + 1`,
      // Stamp the first failure once so the transient gate can measure how long
      // the failure has persisted (references the pre-update value).
      embedFirstFailedAt: sql`COALESCE(${documents.embedFirstFailedAt}, now())`,
      lastEmbedError: redactSecrets(toMessage(err)).slice(0, MAX_EMBED_ERROR_CHARS),
      embedFailedAt: permanent
        ? sql`COALESCE(${documents.embedFailedAt}, now())`
        : sql`CASE WHEN COALESCE(${documents.embedFirstFailedAt}, now()) <= now() - make_interval(hours => ${EMBED_RETRY_WINDOW_HOURS}) THEN COALESCE(${documents.embedFailedAt}, now()) ELSE ${documents.embedFailedAt} END`,
    })
    .where(eq(documents.id, documentId));
}

/** Dead-letter a document that can never produce chunks (no embeddable content). */
async function markDocumentEmbedTerminal(documentId: string, reason: string): Promise<void> {
  await db()
    .update(documents)
    .set({ embedFailedAt: sql`COALESCE(${documents.embedFailedAt}, now())`, lastEmbedError: reason })
    .where(eq(documents.id, documentId));
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
 * (re-)embedding pass and call `embedDocument` for each.
 */
export interface EmbedDocumentArgs {
  documentId: string;
  /** Voyage idempotency key forwarded for cost-attribution greppability. */
  idempotencyKey?: string;
}

export interface EmbedDocumentResult {
  documentId: string;
  chunksWritten: number;
  chunksSkipped: number;
  /** True when nothing was written because the doc had no embeddable content. */
  empty: boolean;
}

export async function embedDocument(args: EmbedDocumentArgs): Promise<EmbedDocumentResult> {
  const docRows = await db().select().from(documents).where(eq(documents.id, args.documentId));
  const doc = docRows[0];
  if (!doc) throw new Error(`[embed-document] not found: ${args.documentId}`);

  const splits = chunkText(doc.content);
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
  const existingChunks = await db()
    .select({ position: chunks.position, contentHash: chunks.contentHash })
    .from(chunks)
    .where(eq(chunks.documentId, doc.id));
  const existingByPosition = new Map(existingChunks.map((c) => [c.position, c.contentHash]));

  const toEmbed: Chunk[] = [];
  const toEmbedHashes: string[] = [];
  for (const chunk of splits) {
    const hash = sha256(chunk.content);
    if (existingByPosition.get(chunk.position) === hash) continue;
    toEmbed.push(chunk);
    toEmbedHashes.push(hash);
  }
  const skipped = splits.length - toEmbed.length;

  if (toEmbed.length === 0) {
    return { documentId: doc.id, chunksWritten: 0, chunksSkipped: skipped, empty: false };
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

  // Upsert per chunk position. The (document_id, position) unique index
  // makes this a single-statement upsert per row.
  for (let i = 0; i < toEmbed.length; i++) {
    const chunk = toEmbed[i]!;
    const vector = vectors[i]!;
    const hash = toEmbedHashes[i]!;
    await db()
      .insert(chunks)
      .values({
        documentId: doc.id,
        userId: doc.userId,
        position: chunk.position,
        content: chunk.content,
        embedding: vector,
        tokenCount: chunk.tokenCount,
        contentHash: hash,
      })
      .onConflictDoUpdate({
        target: [chunks.documentId, chunks.position],
        set: {
          content: chunk.content,
          embedding: vector,
          tokenCount: chunk.tokenCount,
          contentHash: hash,
          updatedAt: new Date(),
        },
      });
  }

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
  source?: string;
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
