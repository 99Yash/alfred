import { assertEmbeddingDimensions, embed } from "@alfred/ai/embeddings";
import { chatMessageUsageSchema } from "@alfred/contracts";
import { db, rowsFromExecute } from "@alfred/db";
import { sha256Hex } from "@alfred/db/hash";
import { buildEmbedFailureSet, EMBED_SUCCESS_RESET, formatVectorFloat32 } from "@alfred/db/helpers";
import {
  agentRuns,
  CHAT_TURN_WORKFLOW_SLUG,
  chatExchanges,
  chatMessages,
  chatThreads,
  type ChatMessage,
  type ChatThread,
} from "@alfred/db/schemas";
import { logger } from "@alfred/logging";
import { and, eq, inArray, isNotNull, isNull, ne, sql } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import { z } from "zod";

/**
 * Past chats are searchable (journal.md section 3). Each exchange (a user message and its reply)
 * gets one `chat_exchanges` row and one embedding. The sweep derives the rows from `chat_messages`,
 * so new turns and the chats from before this table take the same path.
 */

/** Rows that one sweep pairs, and rows that it embeds. */
const CHAT_EXCHANGE_SWEEP_BATCH = 50;

/**
 * The characters of each side that the embedding reads. A long reply would bury the user's words,
 * and the start of a turn usually names its matter.
 */
const CHAT_EXCHANGE_EMBED_SIDE_MAX_CHARS = 4_000;

/** The text that is embedded: the user's words, then the reply. */
function exchangeContent(userContent: string, replyContent: string): string {
  const user = userContent.trim().slice(0, CHAT_EXCHANGE_EMBED_SIDE_MAX_CHARS);
  const reply = replyContent.trim().slice(0, CHAT_EXCHANGE_EMBED_SIDE_MAX_CHARS);

  return reply.length > 0 ? `User: ${user}\n\nAlfred: ${reply}` : `User: ${user}`;
}

const unpairedExchangeRowSchema = z.object({
  user_id: z.string(),
  thread_id: z.string(),
  user_message_id: z.string(),
  user_content: z.string(),
  reply_message_id: z.string(),
  reply_content: z.string(),
});

/**
 * Write a row for each exchange that has none, or whose user message has a newer reply (a retry of
 * a failed turn makes a new reply). The pair comes from the reply's run: a chat-turn run names its
 * user message in `agent_runs.metadata`. The user row carries no run id. A user message with no
 * text (only attachments) has no row.
 */
async function pairChatExchanges(limit: number): Promise<number> {
  const result = await db().execute(sql`
    WITH latest AS (
      SELECT DISTINCT ON (${agentRuns.metadata} ->> 'userMessageId')
        ${agentRuns.metadata} ->> 'userMessageId' AS user_message_id,
        ${chatMessages.id} AS reply_message_id
      FROM ${chatMessages}
      JOIN ${agentRuns} ON ${agentRuns.id} = ${chatMessages.runId}
      WHERE ${chatMessages.role} = 'assistant'
        AND ${agentRuns.workflowSlug} = ${CHAT_TURN_WORKFLOW_SLUG}
      ORDER BY ${agentRuns.metadata} ->> 'userMessageId', ${chatMessages.createdAt} DESC, ${chatMessages.id} DESC
    )
    SELECT u.user_id, u.thread_id, u.id AS user_message_id, u.content AS user_content,
      a.id AS reply_message_id, a.content AS reply_content
    FROM latest l
    JOIN ${chatMessages} u ON u.id = l.user_message_id AND u.role = 'user'
    JOIN ${chatMessages} a ON a.id = l.reply_message_id
      AND a.user_id = u.user_id AND a.thread_id = u.thread_id
    LEFT JOIN ${chatExchanges} e ON e.user_message_id = u.id
    WHERE btrim(u.content) <> ''
      AND (e.id IS NULL OR e.reply_message_id <> a.id)
    ORDER BY u.created_at, u.id
    LIMIT ${limit}
  `);

  const rows = rowsFromExecute(result, unpairedExchangeRowSchema);

  if (rows.length === 0) return 0;

  const values = rows.map((row) => {
    const content = exchangeContent(row.user_content, row.reply_content);

    return {
      userId: row.user_id,
      threadId: row.thread_id,
      userMessageId: row.user_message_id,
      replyMessageId: row.reply_message_id,
      content,
      contentHash: sha256Hex(content),
    };
  });

  // A thread deleted between the read and this write fails the batch on its foreign key. The next
  // sweep no longer reads it, so the batch then goes through.
  await db()
    .insert(chatExchanges)
    .values(values)
    .onConflictDoUpdate({
      target: chatExchanges.userMessageId,
      set: {
        replyMessageId: sql`excluded.reply_message_id`,
        content: sql`excluded.content`,
        contentHash: sql`excluded.content_hash`,
        embedding: null,
        ...EMBED_SUCCESS_RESET,
        updatedAt: new Date(),
      },
    });

  return values.length;
}

/** Embed the rows that have no embedding and are not dead-lettered. */
async function embedPendingChatExchanges(
  limit: number,
): Promise<{ succeeded: number; failed: number }> {
  const pending = await db()
    .select({
      id: chatExchanges.id,
      userId: chatExchanges.userId,
      content: chatExchanges.content,
      contentHash: chatExchanges.contentHash,
    })
    .from(chatExchanges)
    .where(and(isNull(chatExchanges.embedding), isNull(chatExchanges.embedFailedAt)))
    .limit(limit);

  let succeeded = 0;
  let failed = 0;

  for (const row of pending) {
    let vector: number[];

    try {
      vector = await embed(row.content, {
        inputType: "document",
        userId: row.userId,
        idempotencyKey: `chat-exchange-embed:${row.id}:${row.contentHash}`,
      });
      assertEmbeddingDimensions(vector, "chat-exchange");
    } catch (err) {
      failed++;
      // Only the embed call counts toward the poison-pill guard.
      await db()
        .update(chatExchanges)
        .set(
          buildEmbedFailureSet(
            {
              attempts: chatExchanges.embedAttempts,
              firstFailedAt: chatExchanges.embedFirstFailedAt,
              failedAt: chatExchanges.embedFailedAt,
            },
            err,
          ),
        )
        .where(eq(chatExchanges.id, row.id))
        .catch((bookkeepingErr: unknown) => {
          logger.error(
            { err: bookkeepingErr },
            `[chat-exchanges] FAILED to record embed failure for ${row.id}`,
          );
        });
      logger.warn({ err }, `[chat-exchanges] embed failed for ${row.id}`);
      continue;
    }

    try {
      // The hash guard: a reply that changed during the call keeps its NULL for the next sweep.
      await db()
        .update(chatExchanges)
        .set({ embedding: vector, ...EMBED_SUCCESS_RESET })
        .where(and(eq(chatExchanges.id, row.id), eq(chatExchanges.contentHash, row.contentHash)));
      succeeded++;
    } catch (err) {
      // A write failure is not an embed failure, or a good row dead-letters. The next sweep retries.
      failed++;
      logger.warn({ err }, `[chat-exchanges] embedding write failed for ${row.id}`);
    }
  }

  return { succeeded, failed };
}

/** One sweep: pair new exchanges, then embed the pending rows. The memory-cron worker runs it. */
export async function chatExchangeSweep(): Promise<{
  paired: number;
  succeeded: number;
  failed: number;
}> {
  const paired = await pairChatExchanges(CHAT_EXCHANGE_SWEEP_BATCH);
  const { succeeded, failed } = await embedPendingChatExchanges(CHAT_EXCHANGE_SWEEP_BATCH);

  logger.info(`[chat-exchanges] sweep paired=${paired} embedded=${succeeded} failed=${failed}`);

  return { paired, succeeded, failed };
}

/** The two message ids of one exchange. They are stable, while a `chat_exchanges` row can be rebuilt. */
export const chatExchangeRefSchema = z.object({
  userMessageId: z.string().min(1),
  replyMessageId: z.string().min(1),
});

export type ChatExchangeRef = z.infer<typeof chatExchangeRefSchema>;

/** One stored exchange, read from `chat_messages` and `chat_threads`, never from a copy. */
export interface ChatExchangeTurn {
  threadId: string;
  threadTitle: ChatThread["title"];
  user: Pick<ChatMessage, "id" | "content" | "createdAt">;
  reply: Pick<ChatMessage, "id" | "content" | "createdAt" | "status"> & {
    /** The models that wrote the reply, most-used first. Empty when the row recorded none. */
    models: string[];
  };
}

/** The start of a stored turn for a reader, with a mark when it was cut. */
export function chatTurnExcerpt(text: string, maxChars: number): string {
  const clean = text.replaceAll("\u0000", "").trim();

  return clean.length > maxChars ? `${clean.slice(0, maxChars - 1)}…` : clean;
}

/** The models of a reply from its `usage`. A row from before the usage record has none. */
function replyModels(usage: unknown): string[] {
  const parsed = chatMessageUsageSchema.safeParse(usage);

  return parsed.success ? parsed.data.models.map((entry) => entry.model) : [];
}

/**
 * The stored exchanges for these refs, keyed by user message id. A ref whose messages were deleted
 * is absent, so a deleted thread never comes back through a saved ref.
 */
export async function readChatExchangeTurns(
  userId: string,
  refs: readonly ChatExchangeRef[],
): Promise<Map<string, ChatExchangeTurn>> {
  const turns = new Map<string, ChatExchangeTurn>();

  if (refs.length === 0) return turns;

  const userMessage = alias(chatMessages, "user_message");
  const replyMessage = alias(chatMessages, "reply_message");
  const replyByUser = new Map(refs.map((ref) => [ref.userMessageId, ref.replyMessageId]));

  const rows = await db()
    .select({
      threadId: userMessage.threadId,
      threadTitle: chatThreads.title,
      userId: userMessage.id,
      userContent: userMessage.content,
      userCreatedAt: userMessage.createdAt,
      replyId: replyMessage.id,
      replyContent: replyMessage.content,
      replyCreatedAt: replyMessage.createdAt,
      replyStatus: replyMessage.status,
      replyUsage: replyMessage.usage,
    })
    .from(userMessage)
    .innerJoin(
      replyMessage,
      and(
        eq(replyMessage.userId, userMessage.userId),
        eq(replyMessage.threadId, userMessage.threadId),
        inArray(replyMessage.id, [...replyByUser.values()]),
      ),
    )
    .innerJoin(chatThreads, eq(chatThreads.id, userMessage.threadId))
    .where(
      and(
        eq(userMessage.userId, userId),
        eq(userMessage.role, "user"),
        eq(replyMessage.role, "assistant"),
        inArray(userMessage.id, [...replyByUser.keys()]),
      ),
    );

  for (const row of rows) {
    if (replyByUser.get(row.userId) !== row.replyId) continue;

    turns.set(row.userId, {
      threadId: row.threadId,
      threadTitle: row.threadTitle,
      user: { id: row.userId, content: row.userContent, createdAt: row.userCreatedAt },
      reply: {
        id: row.replyId,
        content: row.replyContent,
        createdAt: row.replyCreatedAt,
        status: row.replyStatus,
        models: replyModels(row.replyUsage),
      },
    });
  }

  return turns;
}

export interface RecallChatExchangesArgs {
  userId: string;
  query: string;
  /** The thread that the model already has. Its exchanges are not returned. */
  excludeThreadId?: string;
  limit: number;
  abortSignal?: AbortSignal;
}

export interface ChatExchangeHit extends ChatExchangeTurn {
  /** Cosine similarity in [-1, 1]. */
  similarity: number;
}

/** Semantic recall over past chats, nearest first. */
export async function recallChatExchanges(
  args: RecallChatExchangesArgs,
): Promise<ChatExchangeHit[]> {
  const query = args.query.trim();

  if (query.length === 0 || args.limit <= 0) return [];

  const queryVector = await embed(query, {
    inputType: "query",
    userId: args.userId,
    idempotencyKey: `chat-recall:${args.userId}:${sha256Hex(query)}`,
    ...(args.abortSignal ? { abortSignal: args.abortSignal } : {}),
  });

  assertEmbeddingDimensions(queryVector, "chat-exchange.recall");
  const vectorLiteral = formatVectorFloat32(queryVector);
  // A wide pool from the approximate halfvec index, then a full-precision rerank.
  const candidateLimit = Math.max(args.limit * 5, 50);

  const filters = [eq(chatExchanges.userId, args.userId), isNotNull(chatExchanges.embedding)];

  if (args.excludeThreadId !== undefined) {
    filters.push(ne(chatExchanges.threadId, args.excludeThreadId));
  }

  const nearest = await db().transaction(async (tx) => {
    // HNSW returns at most `hnsw.ef_search` rows (default 40). pgvector caps it at 1000.
    await tx.execute(sql.raw(`SET LOCAL hnsw.ef_search = ${Math.min(candidateLimit, 1000)}`));

    const candidates = tx
      .select({
        userMessageId: chatExchanges.userMessageId,
        replyMessageId: chatExchanges.replyMessageId,
        distance: sql<number>`${chatExchanges.embedding} <=> ${vectorLiteral}::vector`.as(
          "distance",
        ),
      })
      .from(chatExchanges)
      .where(and(...filters))
      .orderBy(sql`${chatExchanges.embedding}::halfvec(1024) <=> ${vectorLiteral}::halfvec(1024)`)
      .limit(candidateLimit)
      .as("candidates");

    return tx
      .select({
        userMessageId: candidates.userMessageId,
        replyMessageId: candidates.replyMessageId,
        distance: candidates.distance,
      })
      .from(candidates)
      .orderBy(candidates.distance)
      .limit(args.limit);
  });

  const turns = await readChatExchangeTurns(args.userId, nearest);
  const hits: ChatExchangeHit[] = [];

  for (const row of nearest) {
    const turn = turns.get(row.userMessageId);

    if (turn) hits.push({ ...turn, similarity: 1 - Number(row.distance) });
  }

  return hits;
}
