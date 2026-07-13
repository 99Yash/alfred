import type { AttributedCall } from "@alfred/ai";
import type { AgentTranscriptMessage } from "@alfred/contracts";

import { conversationSummaryMessage } from "./chat-context-assembly";
import {
  loadChatThreadContext,
  persistConversationSummary,
  type ChatSummaryWatermark,
  type LoadedChatThreadContext,
  type PersistConversationSummaryArgs,
} from "./chat-context-store";
import {
  loadConversationSummaryEvidence,
  type LoadedConversationSummaryEvidence,
} from "./conversation-summary-evidence";
import {
  eligibleConversationSummarySources,
  generateConversationSummary,
  type GenerateConversationSummaryArgs,
} from "./conversation-summary-generator";
import type { ConversationSummary } from "./conversation-summary";
import {
  compareChatMessageWatermarks,
  nullableChatMessageWatermark,
} from "./chat-message-watermark";
import { estimateTranscriptTokens } from "./tokens";

export interface SynchronousConversationCompactionArgs {
  userId: string;
  threadId: string;
  throughWatermark: ChatSummaryWatermark;
  replayTail: readonly AgentTranscriptMessage[];
  replayTailWatermark: ChatSummaryWatermark;
  attribution: Omit<AttributedCall, "kind" | "role">;
  abortSignal?: AbortSignal;
  timeoutMs?: number;
}

export type SynchronousConversationCompactionResult =
  | {
      kind: "persisted";
      summary: ConversationSummary;
      estimatedReplayTokens: number;
      watermark: ChatSummaryWatermark;
    }
  | { kind: "superseded" }
  | { kind: "nothing_to_compact" };

export interface SynchronousConversationCompactionDependencies {
  loadContext?: (userId: string, threadId: string) => Promise<LoadedChatThreadContext | null>;
  loadEvidence?: (args: {
    userId: string;
    threadId: string;
    priorSummary: ConversationSummary | null;
    afterWatermark: ChatSummaryWatermark | null;
    throughWatermark: ChatSummaryWatermark;
  }) => Promise<LoadedConversationSummaryEvidence>;
  generateSummary?: (args: GenerateConversationSummaryArgs) => Promise<ConversationSummary>;
  persistSummary?: (args: PersistConversationSummaryArgs) => Promise<boolean>;
}

/**
 * Perform one foreground summary generation and CAS write. A losing writer
 * returns `superseded`; the caller owns reload + re-estimation because only it
 * has the fully composed request surface that triggered compaction.
 */
export async function compactConversationSynchronously(
  args: SynchronousConversationCompactionArgs,
  dependencies: SynchronousConversationCompactionDependencies = {},
): Promise<SynchronousConversationCompactionResult> {
  const loadContext = dependencies.loadContext ?? loadChatThreadContext;
  const loadEvidence = dependencies.loadEvidence ?? loadConversationSummaryEvidence;
  const generateSummary = dependencies.generateSummary ?? generateConversationSummary;
  const persistSummary = dependencies.persistSummary ?? persistConversationSummary;

  const context = await loadContext(args.userId, args.threadId);
  const expectedWatermark = contextWatermark(context);
  const rebuildFromRaw = context?.invalidSummary === true;
  if (
    !rebuildFromRaw &&
    expectedWatermark &&
    compareChatMessageWatermarks(args.throughWatermark, expectedWatermark) <= 0
  ) {
    return { kind: "nothing_to_compact" };
  }
  const loaded = await loadEvidence({
    userId: args.userId,
    threadId: args.threadId,
    priorSummary: rebuildFromRaw ? null : (context?.summary ?? null),
    afterWatermark: rebuildFromRaw ? null : expectedWatermark,
    throughWatermark: args.throughWatermark,
  });
  const summary = await generateSummary({
    evidence: loaded.evidence,
    attribution: args.attribution,
    abortSignal: args.abortSignal,
    timeoutMs: args.timeoutMs,
  });
  const eligibleSources = eligibleConversationSummarySources(loaded.evidence);
  const estimatedReplayTokens = estimateTranscriptTokens([
    conversationSummaryMessage(summary),
    ...args.replayTail,
  ]);
  const persisted = await persistSummary({
    userId: args.userId,
    threadId: args.threadId,
    summary,
    watermark: loaded.watermark,
    expectedGeneration: context?.compactionGeneration ?? 0,
    expectedWatermark,
    estimatedReplayTokens,
    replayEstimateWatermark: args.replayTailWatermark,
    eligibleSources,
  });
  return persisted
    ? { kind: "persisted", summary, estimatedReplayTokens, watermark: loaded.watermark }
    : { kind: "superseded" };
}

function contextWatermark(context: LoadedChatThreadContext | null): ChatSummaryWatermark | null {
  return nullableChatMessageWatermark(
    context?.summaryWatermarkCreatedAt,
    context?.summaryWatermarkMessageId,
  );
}
