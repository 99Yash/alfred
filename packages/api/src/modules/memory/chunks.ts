import { EMBEDDING_DIMENSIONS, embed } from "@alfred/ai/embeddings";
import { db } from "@alfred/db";
import { formatVectorFloat32 } from "@alfred/db/helpers";
import { memoryChunks, type MemoryChunk } from "@alfred/db/schemas";
import { and, eq, isNotNull, isNull, sql } from "drizzle-orm";
import { createHash } from "node:crypto";
import { z } from "zod";
import {
  jsonRecordSchema,
  type MemoryChunkKind,
  type MemorySource,
  memoryChunkKindSchema,
  memorySourceSchema,
  parseMemorySourceOrDefault,
} from "./types";

export const writeMemoryChunkArgsSchema = z.object({
  userId: z.string().min(1),
  kind: z.enum(["thread_summary", "extraction_run", "cold_start_research", "manual"]),
  content: z.string().min(1).max(50_000),
  source: memorySourceSchema,
  metadata: z.record(z.string(), z.unknown()).optional(),
});
export type WriteMemoryChunkArgs = z.infer<typeof writeMemoryChunkArgsSchema>;

/**
 * Like the DB row, but: the `embedding` vector is dropped in favor of a
 * `hasEmbedding` flag (callers never need the raw 1024-d array), and the
 * jsonb/enum columns are narrowed to their parsed shapes. Every other column
 * tracks `MemoryChunk` ($inferSelect) automatically — only the listed keys are
 * restated, so a new/renamed column surfaces at compile time.
 */
export type MemoryChunkRow = Omit<
  MemoryChunk,
  "embedding" | "kind" | "source" | "metadata"
> & {
  kind: MemoryChunkKind;
  source: MemorySource;
  metadata: Record<string, unknown>;
  hasEmbedding: boolean;
};

function rowToChunk(r: MemoryChunk): MemoryChunkRow {
  const { embedding, kind, source, metadata, ...rest } = r;
  return {
    ...rest,
    kind: memoryChunkKindSchema.parse(kind),
    source: parseMemorySourceOrDefault(source, { kind: "agent" }, `memory_chunks:${r.id}`),
    metadata: jsonRecordSchema.parse(metadata),
    hasEmbedding: embedding != null,
  };
}

function hashContent(s: string): string {
  return createHash("sha256").update(s).digest("hex");
}

/**
 * Insert a memory chunk. Idempotent on `(user_id, kind, content_hash)`
 * so re-running an extraction over the same source is a no-op.
 *
 * `embedding` is left NULL — the caller (or a sweep job) backfills it
 * via `embedMemoryChunk`. Same write-then-embed pattern as `chunks`
 * (see m7b).
 */
export async function writeMemoryChunk(args: WriteMemoryChunkArgs): Promise<MemoryChunkRow> {
  const parsed = writeMemoryChunkArgsSchema.parse(args);
  const contentHash = hashContent(parsed.content);

  const [row] = await db()
    .insert(memoryChunks)
    .values({
      userId: parsed.userId,
      kind: parsed.kind,
      content: parsed.content,
      contentHash,
      source: parsed.source,
      metadata: parsed.metadata ?? {},
    })
    .onConflictDoUpdate({
      target: [memoryChunks.userId, memoryChunks.kind, memoryChunks.contentHash],
      // No-op update returns the existing row; required because plain
      // `onConflictDoNothing` doesn't return on conflict.
      set: { metadata: sql`${memoryChunks.metadata}` },
    })
    .returning();
  if (!row) throw new Error("[memory.chunks] writeMemoryChunk returned no row");
  return rowToChunk(row);
}

/** Backfill `embedding` for an existing chunk. */
export async function embedMemoryChunk(
  chunkId: string,
  userId: string,
  embedding: number[],
): Promise<void> {
  if (embedding.length !== 1024) {
    throw new Error(`[memory] expected 1024-dim embedding, got ${embedding.length}`);
  }
  await db()
    .update(memoryChunks)
    .set({ embedding })
    .where(and(eq(memoryChunks.id, chunkId), eq(memoryChunks.userId, userId)));
}

/** Chunks awaiting embedding — used by the embed-sweep job. */
export async function pendingEmbedChunkIds(userId: string, limit = 50): Promise<string[]> {
  const rows = await db()
    .select({ id: memoryChunks.id })
    .from(memoryChunks)
    .where(and(eq(memoryChunks.userId, userId), isNull(memoryChunks.embedding)))
    .limit(limit);
  return rows.map((r) => r.id);
}

/**
 * Pending chunks across all users — drives the system-wide embed sweep.
 * Returns id + userId + content so the worker can embed without a
 * second roundtrip per row.
 */
export async function findPendingEmbedChunks(
  limit = 50,
): Promise<Array<{ id: string; userId: string; content: string }>> {
  const rows = await db()
    .select({
      id: memoryChunks.id,
      userId: memoryChunks.userId,
      content: memoryChunks.content,
    })
    .from(memoryChunks)
    .where(isNull(memoryChunks.embedding))
    .limit(limit);
  return rows;
}

export interface RecallMemoryArgs {
  userId: string;
  query: string;
  /**
   * Precomputed query embedding. Use this when recall is paired with other
   * retrieval over the same query to avoid duplicate embedding calls.
   */
  queryEmbedding?: number[];
  /** Restrict to a kind (`thread_summary`, …). Default any. */
  kind?: MemoryChunkKind;
  /** Top-K. Default 10. */
  limit?: number;
}

export interface RecallMemoryHit {
  chunkId: string;
  kind: MemoryChunkKind;
  preview: string;
  /** Cosine similarity in [-1, 1]; higher = more similar. */
  similarity: number;
  source: MemorySource;
}

/**
 * Semantic recall over `memory_chunks`. Same shape as `semanticSearch`
 * over the integration corpus, but the indexed surface here is alfred's
 * *interpretation* layer — distilled summaries, not raw provider data.
 *
 * Embeds the query once, sorts by `<=>` (cosine distance) ascending,
 * returns similarity = 1 - distance.
 */
export async function recallMemory(args: RecallMemoryArgs): Promise<RecallMemoryHit[]> {
  const limit = args.limit ?? 10;
  const queryVec =
    args.queryEmbedding ??
    (await embed(args.query, {
      inputType: "query",
      userId: args.userId,
      idempotencyKey: `memory-recall:${args.userId}:${hashContent(args.query)}`,
    }));
  assertQueryEmbedding(queryVec);
  const vectorLiteral = formatVectorFloat32(queryVec);
  // Pull a wider pool from the approximate halfvec index, then rerank with
  // the full-precision vector distance below.
  const candidateLimit = Math.max(limit * 5, 50);

  const filters = [eq(memoryChunks.userId, args.userId), isNotNull(memoryChunks.embedding)];
  if (args.kind) filters.push(eq(memoryChunks.kind, args.kind));

  // HNSW returns at most `hnsw.ef_search` rows per scan (default 40), so the
  // candidate pool is silently truncated unless we raise it to cover
  // candidateLimit. SET LOCAL scopes the bump to this transaction; pgvector
  // caps ef_search at 1000.
  const rows = await db().transaction(async (tx) => {
    await tx.execute(sql.raw(`SET LOCAL hnsw.ef_search = ${Math.min(candidateLimit, 1000)}`));

    const candidates = tx
      .select({
        chunkId: memoryChunks.id,
        kind: memoryChunks.kind,
        content: memoryChunks.content,
        source: memoryChunks.source,
        distance: sql<number>`${memoryChunks.embedding} <=> ${vectorLiteral}::vector`.as(
          "distance",
        ),
      })
      .from(memoryChunks)
      .where(and(...filters))
      .orderBy(sql`${memoryChunks.embedding}::halfvec(1024) <=> ${vectorLiteral}::halfvec(1024)`)
      .limit(candidateLimit)
      .as("candidates");

    return tx
      .select({
        chunkId: candidates.chunkId,
        kind: candidates.kind,
        content: candidates.content,
        source: candidates.source,
        distance: candidates.distance,
      })
      .from(candidates)
      .orderBy(candidates.distance)
      .limit(limit);
  });

  return rows.map((r) => ({
    chunkId: r.chunkId,
    kind: memoryChunkKindSchema.parse(r.kind),
    preview: r.content.length > 280 ? r.content.slice(0, 277) + "…" : r.content,
    similarity: 1 - Number(r.distance),
    source: parseMemorySourceOrDefault(r.source, { kind: "agent" }, `memory_chunks:${r.chunkId}`),
  }));
}

function assertQueryEmbedding(v: number[]): void {
  if (v.length !== EMBEDDING_DIMENSIONS) {
    throw new Error(`[memory.recall] expected ${EMBEDDING_DIMENSIONS}-dim query embedding`);
  }
}
