import { embed } from "@alfred/ai/embeddings";
import { db } from "@alfred/db";
import { formatVectorFloat32 } from "@alfred/db/helpers";
import { chunks, documents } from "@alfred/db/schemas";
import { and, desc, eq, isNotNull, sql } from "drizzle-orm";

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
  userId: string;
  /** Restrict to a particular source (`gmail`, `slack`, …). */
  source?: string;
  /** Top-K. Default 10. */
  limit?: number;
}

export interface SearchHit {
  chunkId: string;
  documentId: string;
  source: string;
  title: string | null;
  position: number;
  /** First ~280 chars of the chunk for surfacing. */
  preview: string;
  /**
   * Cosine similarity in [-1, 1] — 1 = identical direction, 0 =
   * orthogonal, -1 = opposite. In practice with L2-normalized embeddings
   * scores cluster in [0, 1]; do not assume that as a hard bound.
   */
  similarity: number;
  authoredAt: Date | null;
}

export async function semanticSearch(args: SearchArgs): Promise<SearchHit[]> {
  const limit = args.limit ?? 10;
  const queryVec = await embed(args.query, {
    inputType: "query",
    userId: args.userId,
    idempotencyKey: `search:${args.userId}:${hashQuery(args.query)}`,
  });
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
        chunkId: chunks.id,
        documentId: documents.id,
        source: documents.source,
        title: documents.title,
        position: chunks.position,
        content: chunks.content,
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
        authoredAt: candidates.authoredAt,
        distance: candidates.distance,
      })
      .from(candidates)
      .orderBy(candidates.distance)
      .limit(limit);
  });

  return rows.map((r) => ({
    chunkId: r.chunkId,
    documentId: r.documentId,
    source: r.source,
    title: r.title,
    position: r.position,
    preview: r.content.length > 280 ? r.content.slice(0, 277) + "…" : r.content,
    similarity: 1 - Number(r.distance),
    authoredAt: r.authoredAt,
  }));
}

function hashQuery(q: string): string {
  // Stable enough for idempotency keys; doesn't need to be cryptographic.
  let h = 0;
  for (let i = 0; i < q.length; i++) h = ((h << 5) - h + q.charCodeAt(i)) | 0;
  return Math.abs(h).toString(36);
}

// Re-export desc for callers that build their own queries.
export { desc };
