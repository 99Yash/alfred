import { EMBEDDING_DIMENSIONS, embed } from "@alfred/ai/embeddings";
import {
  parseAttachmentContentReferences,
  type AttachmentContentReference,
} from "@alfred/contracts";
import { db } from "@alfred/db";
import { formatVectorFloat32 } from "@alfred/db/helpers";
import { chunks, documents, type Document } from "@alfred/db/schemas";
import { and, eq, isNotNull, sql } from "drizzle-orm";
import { extractPageFromMetadata } from "./chunk-metadata";

/**
 * Semantic search over the chunked corpus. Returns top-K chunks ranked
 * by cosine similarity, joined to their parent document so callers can
 * surface the title + source.
 *
 * pgvector's `<=>` operator computes cosine *distance* in [0, 2]
 * (`1 - cos(θ)`, lower = more similar). We sort ascending and convert
 * to cosine similarity (`cos(θ)` in [-1, 1]) in the result shape so
 * consumers don't deal with the inverted scale.
 */
export interface SearchArgs {
  query: string;
  /**
   * Precomputed query embedding. Use this when several retrieval surfaces
   * share one query so callers do not double-bill the embedding API.
   */
  queryEmbedding?: number[];
  userId: string;
  /** Restrict to a particular source (`gmail`, `slack`, …). */
  source?: Document["source"];
  /** Top-K. Default 10. */
  limit?: number;
}

export interface SearchHit {
  chunkId: string;
  documentId: string;
  source: Document["source"];
  title: string | null;
  position: number;
  /**
   * The 1-indexed PDF page the extractor proved this chunk sits on, when the
   * parent document carries page structure. `null` for every other document —
   * never state a page the extractor did not prove (ADR-0091).
   */
  page: number | null;
  /** First ~280 chars of the chunk for surfacing. */
  preview: string;
  /**
   * Cosine similarity in [-1, 1] — 1 = identical direction, 0 =
   * orthogonal, -1 = opposite. In practice with L2-normalized embeddings
   * scores cluster in [0, 1]; do not assume that as a hard bound.
   */
  similarity: number;
  authoredAt: Date | null;
  /**
   * Other carriers of byte-identical content — the same file forwarded under
   * new `messageId:attachmentId` pairs folds into one canonical row, and each
   * later occurrence is recorded here (filenames, threadIds, mimeTypes), so a
   * question about `Acme_Offer_Letter.pdf` can reconcile against a row titled
   * by the first carrier. Parsed defensively from the document's unknown
   * `metadata.references`; present only on `gmail_attachment` hits that hold
   * at least one valid reference.
   */
  occurrences?: AttachmentContentReference[];
}

export async function search(args: SearchArgs): Promise<SearchHit[]> {
  const limit = args.limit ?? 10;
  const queryVec =
    args.queryEmbedding ??
    (await embed(args.query, {
      inputType: "query",
      userId: args.userId,
      idempotencyKey: `search:${args.userId}:${hashQuery(args.query)}`,
    }));
  assertQueryEmbedding(queryVec);
  // Match the DB vector adapter: pgvector stores float32, so avoid
  // sending float64-precision text for query literals too.
  const vectorLiteral = formatVectorFloat32(queryVec);
  // Pull a wider pool from the approximate halfvec index, then rerank with
  // the full-precision vector distance below.
  const candidateLimit = Math.max(limit * 5, 50);

  const filters = [eq(chunks.userId, args.userId), isNotNull(chunks.embedding)];
  if (args.source) filters.push(eq(documents.source, args.source));

  // HNSW returns at most `hnsw.ef_search` rows per scan (default 40), so the
  // candidate pool is silently truncated unless we raise it to cover
  // candidateLimit. SET LOCAL scopes the bump to this transaction; pgvector
  // caps ef_search at 1000.
  const rows = await db().transaction(async (tx) => {
    await tx.execute(sql.raw(`SET LOCAL hnsw.ef_search = ${Math.min(candidateLimit, 1000)}`));

    const candidates = tx
      .select({
        // Aliased apart: chunks.id and documents.id would otherwise both
        // project as "id" and the outer rerank SELECT could not reference
        // either without an ambiguous-column error.
        chunkId: sql<string>`${chunks.id}`.as("chunk_id"),
        documentId: sql<string>`${documents.id}`.as("document_id"),
        source: documents.source,
        title: documents.title,
        position: chunks.position,
        content: chunks.content,
        metadata: chunks.metadata,
        // Aliased apart from chunks.metadata: two projected columns named
        // "metadata" would collide in the subquery result mapping.
        documentMetadata: sql`${documents.metadata}`.as("document_metadata"),
        authoredAt: documents.authoredAt,
        distance: sql<number>`${chunks.embedding} <=> ${vectorLiteral}::vector`.as("distance"),
      })
      .from(chunks)
      .innerJoin(documents, eq(chunks.documentId, documents.id))
      .where(and(...filters))
      .orderBy(sql`${chunks.embedding}::halfvec(1024) <=> ${vectorLiteral}::halfvec(1024)`)
      .limit(candidateLimit)
      .as("candidates");

    return tx
      .select({
        chunkId: candidates.chunkId,
        documentId: candidates.documentId,
        source: candidates.source,
        title: candidates.title,
        position: candidates.position,
        content: candidates.content,
        metadata: candidates.metadata,
        documentMetadata: candidates.documentMetadata,
        authoredAt: candidates.authoredAt,
        distance: candidates.distance,
      })
      .from(candidates)
      .orderBy(candidates.distance)
      .limit(limit);
  });

  return rows.map((r) => {
    const hit: SearchHit = {
      chunkId: r.chunkId,
      documentId: r.documentId,
      source: r.source,
      title: r.title,
      position: r.position,
      page: extractPageFromMetadata(r.metadata),
      preview: r.content.length > 280 ? r.content.slice(0, 277) + "…" : r.content,
      similarity: 1 - Number(r.distance),
      authoredAt: r.authoredAt,
    };
    if (r.source === "gmail_attachment") {
      const occurrences = parseAttachmentContentReferences(r.documentMetadata);
      if (occurrences.length > 0) hit.occurrences = occurrences;
    }
    return hit;
  });
}

function hashQuery(q: string): string {
  // Stable enough for idempotency keys; doesn't need to be cryptographic.
  let h = 0;
  for (let i = 0; i < q.length; i++) h = ((h << 5) - h + q.charCodeAt(i)) | 0;
  return Math.abs(h).toString(36);
}

function assertQueryEmbedding(v: number[]): void {
  if (v.length !== EMBEDDING_DIMENSIONS) {
    throw new Error(`[semantic-search] expected ${EMBEDDING_DIMENSIONS}-dim query embedding`);
  }
}
