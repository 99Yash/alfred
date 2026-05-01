import { embed } from "@alfred/ai/embeddings";
import { db } from "@alfred/db";
import { chunks, documents } from "@alfred/db/schemas";
import { and, desc, eq, sql } from "drizzle-orm";

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
  // `vector` adapter on writes serializes `[a,b,c]`; for parameter
  // binding via drizzle's sql template we send the same string form.
  const vectorLiteral = `[${queryVec.join(",")}]`;

  const filters = [eq(chunks.userId, args.userId)];
  if (args.source) filters.push(eq(documents.source, args.source));

  const rows = await db()
    .select({
      chunkId: chunks.id,
      documentId: documents.id,
      source: documents.source,
      title: documents.title,
      position: chunks.position,
      content: chunks.content,
      authoredAt: documents.authoredAt,
      distance: sql<number>`${chunks.embedding} <=> ${vectorLiteral}::vector`,
    })
    .from(chunks)
    .innerJoin(documents, eq(chunks.documentId, documents.id))
    .where(and(...filters))
    .orderBy(sql`${chunks.embedding} <=> ${vectorLiteral}::vector`)
    .limit(limit);

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
