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
  estimatedReplayTokens: number;
  eligibleSources: EligibleConversationSummarySources;
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
  const now = new Date();
  const rows = await db()
    .update(chatThreadContext)
    .set({
      summary,
      summaryWatermarkCreatedAt: args.watermark.createdAt,
      summaryWatermarkMessageId: args.watermark.messageId,
      estimatedReplayTokens: args.estimatedReplayTokens,
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
      ),
    )
    .returning({ threadId: chatThreadContext.threadId });
  return rows.length === 1;
}
