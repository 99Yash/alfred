import { EMBEDDING_DIMENSIONS, embed } from "@alfred/ai/embeddings";
import { db } from "@alfred/db";
import { buildEmbedFailureSet, EMBED_SUCCESS_RESET, formatVectorFloat32 } from "@alfred/db/helpers";
import {
  memoryChunkInsertSchema,
  memoryChunks,
  type MemoryChunk,
  type NewMemoryChunk,
} from "@alfred/db/schemas";
import {
  jsonRecordSchema,
  memorySourceSchema,
  parseMemorySourceOrDefault,
  type MemorySource,
} from "@alfred/contracts";
import { and, eq, inArray, isNotNull, isNull, sql } from "drizzle-orm";
import { createHash } from "node:crypto";
import { z } from "zod";

/** `memory_chunks.kind` values. The union derives from the tuple. */
export const MEMORY_CHUNK_KINDS = [
  "thread_summary",
  "extraction_run",
  "cold_start_research",
  "manual",
] as const;

export const memoryChunkKindSchema = z.enum(MEMORY_CHUNK_KINDS);

export type MemoryChunkKind = (typeof MEMORY_CHUNK_KINDS)[number];

/** Alfred's own run telemetry, never user memory. */
const OPERATIONAL_MEMORY_CHUNK_KINDS: ReadonlySet<MemoryChunkKind> = new Set(["extraction_run"]);

/** Derived by subtraction, so a new kind shows by default. */
export const USER_FACING_MEMORY_CHUNK_KINDS: readonly MemoryChunkKind[] = MEMORY_CHUNK_KINDS.filter(
  (kind) => !OPERATIONAL_MEMORY_CHUNK_KINDS.has(kind),
);

export const writeMemoryChunkArgsSchema = memoryChunkInsertSchema
  .pick({ userId: true, kind: true, content: true, source: true, metadata: true })
  .extend({
    userId: z.string().min(1),
    kind: memoryChunkKindSchema,
    content: z.string().min(1).max(50_000),
    source: memorySourceSchema,
    metadata: jsonRecordSchema.optional(),
  }) satisfies z.ZodType<
  Pick<NewMemoryChunk, "userId" | "kind" | "content" | "source" | "metadata">
>;

export type WriteMemoryChunkArgs = z.infer<typeof writeMemoryChunkArgsSchema>;

/** `MemoryChunk` with parsed columns narrowed and `embedding` reduced to `hasEmbedding`. Not synced, so no lifecycle dates. */
export type MemoryChunkRow = Omit<
  MemoryChunk,
  "kind" | "source" | "metadata" | "embedding" | "createdAt" | "updatedAt"
> & {
  kind: MemoryChunkKind;
  source: MemorySource;
  metadata: z.infer<typeof jsonRecordSchema>;
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
 * Insert a memory chunk, idempotent on `(user_id, kind, content_hash)`.
 * `embedding` starts NULL; `embedMemoryChunk` fills it later.
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
      // A no-op update, because `onConflictDoNothing` returns no row on conflict.
      set: { metadata: sql`${memoryChunks.metadata}` },
    })
    .returning();

  if (!row) throw new Error("[memory.chunks] writeMemoryChunk returned no row");

  return rowToChunk(row);
}

/** Fill `embedding` for an existing chunk. */
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
    // Reset the failure streak, so the grace window is per streak, not lifetime.
    .set({ embedding, ...EMBED_SUCCESS_RESET })
    .where(and(eq(memoryChunks.id, chunkId), eq(memoryChunks.userId, userId)));
}

/** No embedding yet and not dead-lettered. Shared by both finders, so neither forgets the guard. */
function memoryChunkEmbedCandidateFilter() {
  return and(isNull(memoryChunks.embedding), isNull(memoryChunks.embedFailedAt));
}

/**
 * Record an embed failure with the shared poison-pill guard (`buildEmbedFailureSet`).
 * Permanent errors dead-letter at once; transient ones retry until the window passes.
 */
export async function recordMemoryEmbedFailure(
  chunkId: string,
  userId: string,
  err: unknown,
): Promise<void> {
  await db()
    .update(memoryChunks)
    .set(
      buildEmbedFailureSet(
        {
          attempts: memoryChunks.embedAttempts,
          firstFailedAt: memoryChunks.embedFirstFailedAt,
          failedAt: memoryChunks.embedFailedAt,
        },
        err,
      ),
    )
    .where(and(eq(memoryChunks.id, chunkId), eq(memoryChunks.userId, userId)));
}

/** Chunks waiting for an embedding, for the embed sweep. */
export async function pendingEmbedChunkIds(userId: string, limit = 50): Promise<string[]> {
  const rows = await db()
    .select({ id: memoryChunks.id })
    .from(memoryChunks)
    .where(and(eq(memoryChunks.userId, userId), memoryChunkEmbedCandidateFilter()))
    .limit(limit);

  return rows.map((r) => r.id);
}

/** Pending chunks for all users, with content, so the worker needs no second read. */
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
    .where(memoryChunkEmbedCandidateFilter())
    .limit(limit);

  return rows;
}

export interface RecallMemoryArgs {
  userId: string;
  query: string;
  /** Pass this to reuse an embedding computed for other retrieval. */
  queryEmbedding?: number[];
  /** Defaults to `USER_FACING_MEMORY_CHUNK_KINDS`. An empty list means no kinds, not any. */
  kinds?: readonly MemoryChunkKind[];
  /** Default 10. */
  limit?: number;
}

export interface RecallMemoryHit {
  chunkId: string;
  kind: MemoryChunkKind;
  preview: string;
  /** Cosine similarity in [-1, 1]. */
  similarity: number;
  source: MemorySource;
}

/** Semantic recall over `memory_chunks`, ranked by cosine distance. */
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
  // A wide pool from the approximate halfvec index, then a full-precision rerank.
  const candidateLimit = Math.max(limit * 5, 50);

  const filters = [eq(memoryChunks.userId, args.userId), isNotNull(memoryChunks.embedding)];

  // Filter kinds in the candidate query, so an excluded kind cannot displace a hit.
  const kinds = args.kinds ?? USER_FACING_MEMORY_CHUNK_KINDS;
  filters.push(kinds.length > 0 ? inArray(memoryChunks.kind, [...kinds]) : sql`false`);

  // HNSW returns at most `hnsw.ef_search` rows (default 40), so raise it for this
  // transaction. pgvector caps it at 1000.
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
