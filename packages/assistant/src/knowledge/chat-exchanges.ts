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
import { and, eq, inArray, isNotNull, isNull, ne, notInArray, or, sql } from "drizzle-orm";
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

/** The deadline of one embed call in the sweep. A stalled call must not hold the memory worker. */
const CHAT_EXCHANGE_EMBED_TIMEOUT_MS = 30_000;

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

  // A message row removed between the read and this write (a user wipe) fails the batch on its
  // foreign key. The next sweep no longer reads it, so the batch then goes through.
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
        abortSignal: AbortSignal.timeout(CHAT_EXCHANGE_EMBED_TIMEOUT_MS),
      });
      assertEmbeddingDimensions(vector, "chat-exchange");
    } catch (err) {
      failed++;
      // Only the embed call counts toward the poison-pill guard. The hash guard: a reply that
      // changed during the call is a new version, and this failure does not use its retries.
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
        .where(and(eq(chatExchanges.id, row.id), eq(chatExchanges.contentHash, row.contentHash)))
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
      const written = await db()
        .update(chatExchanges)
        .set({ embedding: vector, ...EMBED_SUCCESS_RESET })
        .where(and(eq(chatExchanges.id, row.id), eq(chatExchanges.contentHash, row.contentHash)))
        .returning({ id: chatExchanges.id });

      if (written.length > 0) succeeded++;
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

/**
 * The key of one exchange: both message ids. A retried turn has a new reply for the same user
 * message, and a saved ref to the old reply and a saved ref to the new one are both valid.
 */
export function chatExchangeKey(ref: ChatExchangeRef): string {
  return `${ref.userMessageId}:${ref.replyMessageId}`;
}

/** One stored exchange, read from `chat_messages` and `chat_threads`, never from a copy. */
export interface ChatExchangeTurn {
  threadId: string;
  /** The live title. It changes on a rename, so a replayed prompt must not show it. */
  threadTitle: ChatThread["title"];
  /**
   * The user deleted the thread. A delete hides it in the UI only, so recall still reads it and
   * marks it (journal.md section 3). Live, so a replayed prompt must save it, not read it.
   */
  threadDeleted: boolean;
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
 * The stored exchanges for these refs, keyed by {@link chatExchangeKey}. A deleted thread is
 * present, with its mark. A ref is absent only when its message rows are gone (a user wipe).
 */
export async function readChatExchangeTurns(
  userId: string,
  refs: readonly ChatExchangeRef[],
): Promise<Map<string, ChatExchangeTurn>> {
  const turns = new Map<string, ChatExchangeTurn>();
  const unique = [...new Map(refs.map((ref) => [chatExchangeKey(ref), ref])).values()];

  if (unique.length === 0) return turns;

  const userMessage = alias(chatMessages, "user_message");
  const replyMessage = alias(chatMessages, "reply_message");

  const rows = await db()
    .select({
      threadId: userMessage.threadId,
      threadTitle: chatThreads.title,
      threadDeletedAt: chatThreads.deletedAt,
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
      ),
    )
    .innerJoin(chatThreads, eq(chatThreads.id, userMessage.threadId))
    .where(
      and(
        eq(userMessage.userId, userId),
        eq(userMessage.role, "user"),
        eq(replyMessage.role, "assistant"),
        // The id lists let each side use its primary key; the pair list joins only the asked pairs.
        inArray(
          userMessage.id,
          unique.map((ref) => ref.userMessageId),
        ),
        inArray(
          replyMessage.id,
          unique.map((ref) => ref.replyMessageId),
        ),
        or(
          ...unique.map((ref) =>
            and(eq(userMessage.id, ref.userMessageId), eq(replyMessage.id, ref.replyMessageId)),
          ),
        ),
      ),
    );

  for (const row of rows) {
    turns.set(chatExchangeKey({ userMessageId: row.userId, replyMessageId: row.replyId }), {
      threadId: row.threadId,
      threadTitle: row.threadTitle,
      threadDeleted: row.threadDeletedAt !== null,
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
  /** Exchanges that the model already has from an earlier recall. They are not returned. */
  excludeUserMessageIds?: readonly string[];
  limit: number;
  abortSignal?: AbortSignal;
}

export interface ChatExchangeHit extends ChatExchangeTurn {
  /** Cosine similarity in [-1, 1]. */
  similarity: number;
}

/**
 * Semantic recall over past chats, nearest first. The search is exact: one user has a few thousand
 * exchanges, and an approximate index applies the thread filter after its scan, so it can miss
 * every eligible row. When the user has no eligible exchange, no query is embedded.
 */
export async function recallChatExchanges(
  args: RecallChatExchangesArgs,
): Promise<ChatExchangeHit[]> {
  const query = args.query.trim();

  if (query.length === 0 || args.limit <= 0) return [];

  const filters = [eq(chatExchanges.userId, args.userId), isNotNull(chatExchanges.embedding)];

  if (args.excludeThreadId !== undefined) {
    filters.push(ne(chatExchanges.threadId, args.excludeThreadId));
  }

  if (args.excludeUserMessageIds !== undefined && args.excludeUserMessageIds.length > 0) {
    filters.push(notInArray(chatExchanges.userMessageId, [...args.excludeUserMessageIds]));
  }

  const [eligible] = await db()
    .select({ id: chatExchanges.id })
    .from(chatExchanges)
    .where(and(...filters))
    .limit(1);

  if (!eligible) return [];

  const queryVector = await embed(query, {
    inputType: "query",
    userId: args.userId,
    idempotencyKey: `chat-recall:${args.userId}:${sha256Hex(query)}`,
    ...(args.abortSignal ? { abortSignal: args.abortSignal } : {}),
  });

  assertEmbeddingDimensions(queryVector, "chat-exchange.recall");
  const distance = sql<number>`${chatExchanges.embedding} <=> ${formatVectorFloat32(queryVector)}::vector`;

  const nearest = await db()
    .select({
      userMessageId: chatExchanges.userMessageId,
      replyMessageId: chatExchanges.replyMessageId,
      distance,
    })
    .from(chatExchanges)
    .where(and(...filters))
    .orderBy(distance)
    .limit(args.limit);

  const turns = await readChatExchangeTurns(args.userId, nearest);
  const hits: ChatExchangeHit[] = [];

  for (const row of nearest) {
    const turn = turns.get(chatExchangeKey(row));

    if (turn) hits.push({ ...turn, similarity: 1 - Number(row.distance) });
  }

  return hits;
}
