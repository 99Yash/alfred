import { embedMany } from "@alfred/ai/embeddings";
import { db } from "@alfred/db";
import { chunks, documents } from "@alfred/db/schemas";
import { and, desc, eq, notExists, sql } from "drizzle-orm";
import { createHash } from "node:crypto";
import { chunkText, type Chunk } from "./chunker";

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

  const vectors = await embedMany(
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
    db().select({ one: sql`1` }).from(chunks).where(eq(chunks.documentId, documents.id)),
  );
  const filters = [noChunksFilter];
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
