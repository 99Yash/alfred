import { EMBEDDING_DIMENSIONS, embed } from "@alfred/ai/embeddings";
import {
  parseAttachmentContentReferences,
  getStringPath,
  type AttachmentContentReference,
} from "@alfred/contracts";
import { db } from "@alfred/db";
import { formatVectorFloat32 } from "@alfred/db/helpers";
import { chunks, documents, type Document } from "@alfred/db/schemas";
import { and, eq, isNotNull, sql } from "drizzle-orm";
import { extractPageFromMetadata } from "./chunk-metadata";

export interface SearchArgs {
  query: string;
  /** Pass this when several searches share one query, to pay for one embedding. */
  queryEmbedding?: number[];
  userId: string;
  source?: Document["source"];
  /** Default 10. */
  limit?: number;
}

/**
 * The provider identity of the parent document.
 * `sourceId` is the provider id, or Alfred's receipt id for a webhook source.
 * For `gmail_attachment` it packs only the first carrier's ids: do not split it;
 * use `occurrences` for each carrier.
 */
export type RecordIdentity = Pick<Document, "sourceId" | "sourceThreadId" | "accountId">;

export interface SearchHit {
  chunkId: string;
  documentId: string;
  source: Document["source"];
  /** Not for the model. Put new lookup fields here so {@link ModelFacingHit} drops them too. */
  record: RecordIdentity;
  title: string | null;
  /** The inbound event type (for example `pull_request`), not the record's shape. */
  kind?: string;
  url?: string;
  position: number;
  /** 1-indexed PDF page the extractor proved, else `null`. Never guess a page (ADR-0091). */
  page: number | null;
  /** First 280 chars of the chunk. */
  preview: string;
  /** Cosine similarity in [-1, 1]. Usually in [0, 1], but that is not a bound. */
  similarity: number;
  authoredAt: Date | null;
  /**
   * Other emails that carry the same attachment bytes, with their own filenames.
   * The row title comes from the first carrier only. Set only on `gmail_attachment` hits.
   */
  occurrences?: AttachmentContentReference[];
}

/** A hit as the model sees it: `SearchHit` without `record`. */
export type ModelFacingHit = Omit<SearchHit, "record">;

/** Drop `record`. A field added beside it reaches the model. */
export function toModelFacingHit(hit: SearchHit): ModelFacingHit {
  const { record: _record, ...rest } = hit;

  return rest;
}

/** Top chunks by cosine similarity, with their parent document. `<=>` is distance, so similarity = 1 - distance. */
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
  // pgvector stores float32, so send float32 text like the DB adapter does.
  const vectorLiteral = formatVectorFloat32(queryVec);
  // Take a wider pool from the approximate halfvec index, then rerank at full precision.
  const candidateLimit = Math.max(limit * 5, 50);

  const filters = [eq(chunks.userId, args.userId), isNotNull(chunks.embedding)];

  if (args.source) filters.push(eq(documents.source, args.source));

  // HNSW returns at most `hnsw.ef_search` rows (default 40), which would silently
  // cut the pool. SET LOCAL keeps the change in this transaction. Max is 1000.
  const rows = await db().transaction(async (tx) => {
    await tx.execute(sql.raw(`SET LOCAL hnsw.ef_search = ${Math.min(candidateLimit, 1000)}`));

    const candidates = tx
      .select({
        // Both ids would project as "id" and be ambiguous in the outer SELECT.
        chunkId: sql<string>`${chunks.id}`.as("chunk_id"),
        documentId: sql<string>`${documents.id}`.as("document_id"),
        source: documents.source,
        sourceId: documents.sourceId,
        sourceThreadId: documents.sourceThreadId,
        accountId: documents.accountId,
        title: documents.title,
        url: documents.url,
        position: chunks.position,
        content: chunks.content,
        metadata: chunks.metadata,
        // Two "metadata" columns would collide in the subquery.
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
        sourceId: candidates.sourceId,
        sourceThreadId: candidates.sourceThreadId,
        accountId: candidates.accountId,
        title: candidates.title,
        url: candidates.url,
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
      record: {
        sourceId: r.sourceId,
        sourceThreadId: r.sourceThreadId,
        accountId: r.accountId,
      },
      title: r.title,
      position: r.position,
      page: extractPageFromMetadata(r.metadata),
      preview: r.content.length > 280 ? r.content.slice(0, 277) + "…" : r.content,
      similarity: 1 - Number(r.distance),
      authoredAt: r.authoredAt,
    };

    const kind = getStringPath(r.documentMetadata, "kind");

    if (kind) hit.kind = kind;

    if (r.url) hit.url = r.url;

    if (r.source === "gmail_attachment") {
      const occurrences = parseAttachmentContentReferences(r.documentMetadata);

      if (occurrences.length > 0) hit.occurrences = occurrences;
    }

    return hit;
  });
}

function hashQuery(q: string): string {
  // Not cryptographic. Only an idempotency key.
  let h = 0;

  for (let i = 0; i < q.length; i++) h = ((h << 5) - h + q.charCodeAt(i)) | 0;

  return Math.abs(h).toString(36);
}

function assertQueryEmbedding(v: number[]): void {
  if (v.length !== EMBEDDING_DIMENSIONS) {
    throw new Error(`[semantic-search] expected ${EMBEDDING_DIMENSIONS}-dim query embedding`);
  }
}
