import {
  COMPACTOR_MODEL,
  getChatModel,
  resolveEffectiveInputWindowTokens,
  type ChatModelTier,
} from "@alfred/ai";
import type { AgentTranscriptMessage } from "@alfred/contracts";
import { db } from "@alfred/db";
import { chatAttachmentRepresentations, chatAttachments, chatMessages } from "@alfred/db/schemas";
import { and, asc, desc, eq, gt, inArray, isNull, or } from "drizzle-orm";

import {
  CHAT_ATTACHMENT_REPRESENTATION_VERSION,
  estimateAttachmentEnrichmentCostMicrousd,
  selectAttachmentsWithinEnrichmentBudget,
  shouldStartMediaEnrichment,
} from "../../chat/attachment-enrichment";
import { enqueueChatAttachmentEnrichment } from "../../integrations/queue";
import { enqueueConversationCompaction } from "./conversation-compaction-queue";
import {
  loadChatThreadContext,
  persistConversationReplayEstimate,
  type ChatSummaryWatermark,
} from "./chat-context-store";
import { CHAT_MAX_OUTPUT_TOKENS } from "./chat-request-pressure";
import { estimateSerializedTokens } from "./tokens";

export const BACKGROUND_COMPACTION_RATIO = 0.6;
export const BACKGROUND_COMPACTION_ABSOLUTE_CAP_TOKENS = 200_000;

export function backgroundCompactionThresholdTokens(effectiveInputWindowTokens: number): number {
  if (!Number.isFinite(effectiveInputWindowTokens) || effectiveInputWindowTokens < 0) {
    throw new Error("effectiveInputWindowTokens must be non-negative");
  }
  return Math.min(
    Math.floor(effectiveInputWindowTokens * BACKGROUND_COMPACTION_RATIO),
    BACKGROUND_COMPACTION_ABSOLUTE_CAP_TOKENS,
  );
}

/** Best-effort post-turn pressure check; never delay or fail a completed chat. */
export async function scheduleConversationCompactionIfNeeded(args: {
  userId: string;
  threadId: string;
  latestUserMessageId: string | undefined;
  tier: ChatModelTier;
}): Promise<"scheduled" | "deduplicated" | "disabled" | "below_threshold" | "no_boundary"> {
  const context = await loadChatThreadContext(args.userId, args.threadId);
  const estimateWatermark = replayEstimateWatermark(context);
  const afterEstimate = estimateWatermark
    ? or(
        gt(chatMessages.createdAt, estimateWatermark.createdAt),
        and(
          eq(chatMessages.createdAt, estimateWatermark.createdAt),
          gt(chatMessages.id, estimateWatermark.messageId),
        ),
      )
    : undefined;
  const rows = await db()
    .select({
      id: chatMessages.id,
      role: chatMessages.role,
      content: chatMessages.content,
      toolCalls: chatMessages.toolCalls,
      createdAt: chatMessages.createdAt,
    })
    .from(chatMessages)
    .where(
      and(
        eq(chatMessages.userId, args.userId),
        eq(chatMessages.threadId, args.threadId),
        afterEstimate,
      ),
    )
    .orderBy(asc(chatMessages.createdAt), asc(chatMessages.id));
  if (rows.length === 0) return "no_boundary";

  const attachments = await db()
    .select({
      id: chatAttachments.id,
      messageId: chatAttachments.messageId,
      status: chatAttachments.status,
      degradedText: chatAttachments.degradedText,
      degradedImageKeys: chatAttachments.degradedImageKeys,
      size: chatAttachments.size,
    })
    .from(chatAttachments)
    .where(
      and(
        eq(chatAttachments.userId, args.userId),
        inArray(
          chatAttachments.messageId,
          rows.map((row) => row.id),
        ),
      ),
    );
  const estimatedReplayTokens =
    (context?.estimatedReplayTokens ?? 0) +
    estimateSerializedTokens({ messages: rows, attachments });
  const estimateThrough = rows[rows.length - 1]!;
  const advanced = await persistConversationReplayEstimate({
    userId: args.userId,
    threadId: args.threadId,
    expectedGeneration: context?.compactionGeneration ?? 0,
    expectedWatermark: estimateWatermark,
    estimatedReplayTokens,
    watermark: { messageId: estimateThrough.id, createdAt: estimateThrough.createdAt },
  });
  // A compactor or duplicate finalizer won the CAS. Its estimate is newer; the
  // next successful turn will advance from that watermark.
  if (!advanced) return "deduplicated";
  const effectiveInputWindowTokens = await resolveEffectiveInputWindowTokens({
    models: [getChatModel(args.tier), COMPACTOR_MODEL],
    outputReserveTokens: CHAT_MAX_OUTPUT_TOKENS,
  });
  const backgroundThreshold = backgroundCompactionThresholdTokens(effectiveInputWindowTokens);
  if (shouldStartMediaEnrichment(estimatedReplayTokens, backgroundThreshold)) {
    await scheduleThreadMediaEnrichment(args.userId, args.threadId);
  }
  if (estimatedReplayTokens <= backgroundThreshold) {
    return "below_threshold";
  }

  let latestUserIndex = -1;
  for (let index = rows.length - 1; index >= 0; index -= 1) {
    const row = rows[index]!;
    if (row.role !== "user") continue;
    if (args.latestUserMessageId && row.id !== args.latestUserMessageId) continue;
    latestUserIndex = index;
    break;
  }
  if (latestUserIndex <= 0) return "no_boundary";
  const cutoff = rows[latestUserIndex - 1]!;
  const replayTail: AgentTranscriptMessage[] = rows.slice(latestUserIndex).map((row) => ({
    role: row.role,
    content: row.content,
  }));
  return enqueueConversationCompaction({
    userId: args.userId,
    threadId: args.threadId,
    throughWatermark: { messageId: cutoff.id, createdAt: cutoff.createdAt },
    replayTail,
    replayTailWatermark: { messageId: estimateThrough.id, createdAt: estimateThrough.createdAt },
  });
}

async function scheduleThreadMediaEnrichment(userId: string, threadId: string): Promise<void> {
  const candidates = await db()
    .select({ id: chatAttachments.id, size: chatAttachments.size })
    .from(chatAttachments)
    .innerJoin(chatMessages, eq(chatMessages.id, chatAttachments.messageId))
    .leftJoin(
      chatAttachmentRepresentations,
      and(
        eq(chatAttachmentRepresentations.attachmentId, chatAttachments.id),
        eq(
          chatAttachmentRepresentations.representationVersion,
          CHAT_ATTACHMENT_REPRESENTATION_VERSION,
        ),
      ),
    )
    .where(
      and(
        eq(chatAttachments.userId, userId),
        eq(chatMessages.userId, userId),
        eq(chatMessages.threadId, threadId),
        eq(chatAttachments.status, "ready"),
        isNull(chatAttachmentRepresentations.attachmentId),
      ),
    )
    .orderBy(desc(chatMessages.createdAt), desc(chatMessages.id), asc(chatAttachments.position));
  const selected = selectAttachmentsWithinEnrichmentBudget(
    candidates.map((candidate) => ({
      ...candidate,
      estimatedCostMicrousd: estimateAttachmentEnrichmentCostMicrousd(candidate.size),
    })),
  );
  await Promise.all(
    selected.map((candidate) =>
      enqueueChatAttachmentEnrichment({
        userId,
        attachmentId: candidate.id,
        estimatedCostMicrousd: candidate.estimatedCostMicrousd,
      }),
    ),
  );
}

function replayEstimateWatermark(
  context: Awaited<ReturnType<typeof loadChatThreadContext>>,
): ChatSummaryWatermark | null {
  if (!context?.replayEstimateWatermarkCreatedAt || !context.replayEstimateWatermarkMessageId) {
    return null;
  }
  return {
    createdAt: context.replayEstimateWatermarkCreatedAt,
    messageId: context.replayEstimateWatermarkMessageId,
  };
}
