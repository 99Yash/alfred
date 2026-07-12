import { db } from "@alfred/db";
import { chatThreadContext, type ChatThreadContext } from "@alfred/db/schemas";
import { and, eq, isNull, sql } from "drizzle-orm";
import type { AgentDbExecutor } from "../types";
import {
  parsePersistedConversationSummary,
  validateConversationSummary,
  type ConversationSummary,
  type EligibleConversationSummarySources,
} from "./conversation-summary";

export interface ChatSummaryWatermark {
  createdAt: Date;
  messageId: string;
}

export interface LoadedChatThreadContext extends Omit<ChatThreadContext, "summary"> {
  summary: ConversationSummary | null;
  invalidSummary: boolean;
}

export async function loadChatThreadContext(
  userId: string,
  threadId: string,
  ex: AgentDbExecutor = db(),
): Promise<LoadedChatThreadContext | null> {
  const [row] = await ex
    .select()
    .from(chatThreadContext)
    .where(and(eq(chatThreadContext.userId, userId), eq(chatThreadContext.threadId, threadId)))
    .limit(1);
  if (!row) return null;
  const parsed = parsePersistedConversationSummary(row.summary);
  return {
    ...row,
    summary: parsed.summary,
    invalidSummary: parsed.invalid,
  };
}

export interface PersistConversationSummaryArgs {
  userId: string;
  threadId: string;
  summary: unknown;
  watermark: ChatSummaryWatermark;
  expectedGeneration: number;
  expectedWatermark: ChatSummaryWatermark | null;
  expectedReplayEstimateWatermark: ChatSummaryWatermark | null;
  estimatedReplayTokens: number;
  replayEstimateWatermark: ChatSummaryWatermark;
  eligibleSources: EligibleConversationSummarySources;
}

export async function markConversationCompactionRequested(
  userId: string,
  threadId: string,
  ex: AgentDbExecutor = db(),
): Promise<{ requestedAt: Date; generation: number }> {
  const requestedAt = new Date();
  const [row] = await ex
    .insert(chatThreadContext)
    .values({ userId, threadId, compactionRequestedAt: requestedAt })
    .onConflictDoUpdate({
      target: chatThreadContext.threadId,
      set: { compactionRequestedAt: requestedAt, updatedAt: requestedAt },
      setWhere: eq(chatThreadContext.userId, userId),
    })
    .returning({ generation: chatThreadContext.compactionGeneration });
  if (!row) throw new Error("conversation_compaction_request_not_recorded");
  return { requestedAt, generation: row.generation };
}

export async function recordConversationCompactionFailure(
  args: {
    userId: string;
    threadId: string;
    expectedGeneration: number;
    expectedRequestedAt: Date;
    category: string;
    message: string;
  },
  ex: AgentDbExecutor = db(),
): Promise<boolean> {
  const failedAt = new Date();
  const rows = await ex
    .update(chatThreadContext)
    .set({
      compactionFailedAt: failedAt,
      compactionFailureCategory: args.category.slice(0, 100),
      compactionFailureMessage: args.message.slice(0, 1_000),
      updatedAt: failedAt,
    })
    .where(
      and(
        eq(chatThreadContext.userId, args.userId),
        eq(chatThreadContext.threadId, args.threadId),
        eq(chatThreadContext.compactionGeneration, args.expectedGeneration),
        eq(chatThreadContext.compactionRequestedAt, args.expectedRequestedAt),
      ),
    )
    .returning({ threadId: chatThreadContext.threadId });
  return rows.length === 1;
}

/** CAS the replay estimate so turn retries cannot double-count persisted rows. */
export async function persistConversationReplayEstimate(
  args: {
    userId: string;
    threadId: string;
    expectedGeneration: number;
    expectedWatermark: ChatSummaryWatermark | null;
    estimatedReplayTokens: number;
    watermark: ChatSummaryWatermark;
  },
  ex: AgentDbExecutor = db(),
): Promise<boolean> {
  await ex
    .insert(chatThreadContext)
    .values({ userId: args.userId, threadId: args.threadId })
    .onConflictDoNothing({ target: chatThreadContext.threadId });
  const watermarkPredicate = args.expectedWatermark
    ? and(
        eq(chatThreadContext.replayEstimateWatermarkCreatedAt, args.expectedWatermark.createdAt),
        eq(chatThreadContext.replayEstimateWatermarkMessageId, args.expectedWatermark.messageId),
      )
    : and(
        isNull(chatThreadContext.replayEstimateWatermarkCreatedAt),
        isNull(chatThreadContext.replayEstimateWatermarkMessageId),
      );
  const rows = await ex
    .update(chatThreadContext)
    .set({
      estimatedReplayTokens: args.estimatedReplayTokens,
      replayEstimateWatermarkCreatedAt: args.watermark.createdAt,
      replayEstimateWatermarkMessageId: args.watermark.messageId,
      updatedAt: new Date(),
    })
    .where(
      and(
        eq(chatThreadContext.userId, args.userId),
        eq(chatThreadContext.threadId, args.threadId),
        eq(chatThreadContext.compactionGeneration, args.expectedGeneration),
        watermarkPredicate,
      ),
    )
    .returning({ threadId: chatThreadContext.threadId });
  return rows.length === 1;
}

/**
 * Persist a validated summary only if the generation and compound watermark
 * still match the state read by the compactor. A losing job returns `false`
 * without replacing newer context.
 */
export async function persistConversationSummary(
  args: PersistConversationSummaryArgs,
): Promise<boolean> {
  if (!Number.isInteger(args.estimatedReplayTokens) || args.estimatedReplayTokens < 0) {
    throw new Error("estimatedReplayTokens must be a non-negative integer");
  }
  if (!Number.isInteger(args.expectedGeneration) || args.expectedGeneration < 0) {
    throw new Error("expectedGeneration must be a non-negative integer");
  }
  const summary = validateConversationSummary(args.summary, args.eligibleSources);
  if (!args.eligibleSources.messageIds.has(args.watermark.messageId)) {
    throw new Error("conversation_summary_invalid_provenance: watermark message");
  }

  await db()
    .insert(chatThreadContext)
    .values({ userId: args.userId, threadId: args.threadId })
    .onConflictDoNothing({ target: chatThreadContext.threadId });

  const watermarkPredicate = args.expectedWatermark
    ? and(
        eq(chatThreadContext.summaryWatermarkCreatedAt, args.expectedWatermark.createdAt),
        eq(chatThreadContext.summaryWatermarkMessageId, args.expectedWatermark.messageId),
      )
    : and(
        isNull(chatThreadContext.summaryWatermarkCreatedAt),
        isNull(chatThreadContext.summaryWatermarkMessageId),
      );
  const replayEstimatePredicate = args.expectedReplayEstimateWatermark
    ? and(
        eq(
          chatThreadContext.replayEstimateWatermarkCreatedAt,
          args.expectedReplayEstimateWatermark.createdAt,
        ),
        eq(
          chatThreadContext.replayEstimateWatermarkMessageId,
          args.expectedReplayEstimateWatermark.messageId,
        ),
      )
    : and(
        isNull(chatThreadContext.replayEstimateWatermarkCreatedAt),
        isNull(chatThreadContext.replayEstimateWatermarkMessageId),
      );
  const now = new Date();
  const rows = await db()
    .update(chatThreadContext)
    .set({
      summary,
      summaryWatermarkCreatedAt: args.watermark.createdAt,
      summaryWatermarkMessageId: args.watermark.messageId,
      estimatedReplayTokens: args.estimatedReplayTokens,
      replayEstimateWatermarkCreatedAt: args.replayEstimateWatermark.createdAt,
      replayEstimateWatermarkMessageId: args.replayEstimateWatermark.messageId,
      compactionCompletedAt: now,
      compactionFailedAt: null,
      compactionFailureCategory: null,
      compactionFailureMessage: null,
      compactionGeneration: sql`${chatThreadContext.compactionGeneration} + 1`,
      updatedAt: now,
    })
    .where(
      and(
        eq(chatThreadContext.userId, args.userId),
        eq(chatThreadContext.threadId, args.threadId),
        eq(chatThreadContext.compactionGeneration, args.expectedGeneration),
        watermarkPredicate,
        replayEstimatePredicate,
      ),
    )
    .returning({ threadId: chatThreadContext.threadId });
  return rows.length === 1;
}
