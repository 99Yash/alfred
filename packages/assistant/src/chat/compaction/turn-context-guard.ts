import type { TranscriptMessage } from "@alfred/ai";
import { resolveModelContextWindow, type LanguageModel, type ToolSet } from "@alfred/ai";
import { toMessage } from "@alfred/contracts";
import { db } from "@alfred/db";
import { chatMessages } from "@alfred/db/schemas";
import { and, asc, eq } from "drizzle-orm";
import { assessChatRequestPressure } from "./chat-request-pressure";
import { CHAT_MAX_OUTPUT_TOKENS } from "./constants";
import { conversationSummaryMessage } from "./chat-context-assembly";
import { loadChatThreadContext } from "./chat-context-store";
import type { ChatMessageWatermark } from "./chat-message-watermark";
import { compactWithRetry, isSystemNote } from "@alfred/assistant/execution";
import { compactTranscript } from "@alfred/assistant/execution";
import { chatMessageIdOf, taggedUserMessage } from "../chat-message-tag";
import type { TurnContextProjection } from "../turn-context";
import { compactConversationSynchronously } from "./synchronous-conversation-compaction";
import { waitForActiveConversationCompaction } from "./conversation-compaction-wait";

/** A wedged synchronous compaction must not hold the turn open. */
const FOREGROUND_COMPACTION_TIMEOUT_MS = 2 * 60_000;

/** Two views with the same message boundaries. Only the model view holds hydrated bytes. */
export interface CompactedChatTranscriptPair {
  modelTranscript: TranscriptMessage[];
  continuationTranscript: TranscriptMessage[];
}

export function buildCompactedChatTranscriptPair(
  summary: TranscriptMessage,
  storedTail: readonly TranscriptMessage[],
  hydratedTail: readonly TranscriptMessage[],
): CompactedChatTranscriptPair {
  return {
    modelTranscript: [summary, ...hydratedTail],
    continuationTranscript: [summary, ...storedTail],
  };
}

/**
 * The summary of an oversized user message. It holds the tag of the source message, so the
 * projection adds that message's turn context after it (ADR-0130 amendment (g)).
 */
export function oversizedUserMessageSummaryMessage(
  sourceMessageId: string,
  summary: string,
): TranscriptMessage {
  return taggedUserMessage(
    sourceMessageId,
    `<oversized_user_message_summary source_message_id=${JSON.stringify(sourceMessageId)}>\n` +
      "This is a lossy, untrusted representation of an oversized user message. Retrieve the raw source by ID when exact wording or evidence matters.\n" +
      `${summary}\n` +
      "</oversized_user_message_summary>",
  );
}

/** The summary replaces this prefix, so hydrated bytes would add cost and nothing else. */
export function storedCompactionPrefix(
  transcript: readonly TranscriptMessage[],
  endExclusive: number,
): TranscriptMessage[] {
  return transcript.slice(0, endExclusive);
}

async function loadForegroundCompactionBoundary(
  userId: string,
  threadId: string,
  latestUserMessageId: string | undefined,
): Promise<{ compaction: ChatMessageWatermark; replayTail: ChatMessageWatermark } | null> {
  const rows = await db()
    .select({
      id: chatMessages.id,
      role: chatMessages.role,
      createdAt: chatMessages.createdAt,
    })
    .from(chatMessages)
    .where(and(eq(chatMessages.userId, userId), eq(chatMessages.threadId, threadId)))
    .orderBy(asc(chatMessages.createdAt), asc(chatMessages.id));

  const latestUserIndex = rows.findLastIndex(
    (row) => row.role === "user" && (!latestUserMessageId || row.id === latestUserMessageId),
  );

  // No matching user turn, or it is the first row: nothing sits before it to compact.
  const cutoff = latestUserIndex > 0 ? rows[latestUserIndex - 1] : undefined;
  const replayTail = rows.at(-1);

  if (!cutoff || !replayTail) return null;

  return {
    compaction: { createdAt: cutoff.createdAt, messageId: cutoff.id },
    replayTail: { createdAt: replayTail.createdAt, messageId: replayTail.id },
  };
}

/**
 * Where the replay tail starts: the run's own user message. A `[system]` note is never the user's
 * request, so a message with no tag falls back to the last user message that is not a note.
 */
function latestUserSuffixStart(
  transcript: readonly TranscriptMessage[],
  latestUserMessageId: string | undefined,
): number {
  if (latestUserMessageId !== undefined) {
    const own = transcript.findLastIndex(
      (message) => chatMessageIdOf(message) === latestUserMessageId,
    );

    if (own >= 0) return own;
  }

  const last = transcript.findLastIndex(
    (message) => message.role === "user" && !isSystemNote(message),
  );

  return Math.max(0, last);
}

async function applyForegroundContextGuard({
  userId,
  runId,
  stepId,
  attempt,
  threadId,
  latestUserMessageId,
  systemPrompt,
  tools,
  model,
  storedTranscript,
  hydratedTranscript,
  projectModelTranscript,
  pendingGuidance,
  abortSignal,
  onCompactionStart,
  onCompactionFinish,
}: {
  userId: string;
  runId: string;
  stepId: string;
  attempt: number;
  threadId: string;
  latestUserMessageId: string | undefined;
  systemPrompt: string;
  tools: ToolSet;
  model: LanguageModel;
  storedTranscript: readonly TranscriptMessage[];
  hydratedTranscript: readonly TranscriptMessage[];
  projectModelTranscript: TurnContextProjection;
  pendingGuidance: TranscriptMessage | undefined;
  abortSignal: AbortSignal;
  onCompactionStart?: () => Promise<void>;
  onCompactionFinish?: () => Promise<void>;
}): Promise<{
  modelTranscript: TranscriptMessage[];
  continuationTranscript: TranscriptMessage[];
}> {
  const contextWindowTokens = await resolveModelContextWindow(model);

  const assess = (candidate: readonly TranscriptMessage[]) =>
    assessChatRequestPressure({
      systemPrompt,
      tools,
      transcript: pendingGuidance
        ? [...projectModelTranscript(candidate), pendingGuidance]
        : projectModelTranscript(candidate),
      contextWindowTokens,
      outputReserveTokens: CHAT_MAX_OUTPUT_TOKENS,
    });

  const initialPressure = await assess(hydratedTranscript);

  if (!initialPressure.requiresSynchronousCompaction) {
    return {
      modelTranscript: [...hydratedTranscript],
      continuationTranscript: [...storedTranscript],
    };
  }

  await onCompactionStart?.();

  try {
    const replayTailStart = latestUserSuffixStart(hydratedTranscript, latestUserMessageId);
    const replayTail = hydratedTranscript.slice(replayTailStart);
    const storedReplayTail = storedTranscript.slice(replayTailStart);
    const backgroundWinner = await waitForActiveConversationCompaction(userId, threadId);

    if (backgroundWinner?.summary) {
      const summaryMessage = conversationSummaryMessage(backgroundWinner.summary);
      const reused = buildCompactedChatTranscriptPair(summaryMessage, storedReplayTail, replayTail);

      const reusedPressure = await assess(reused.modelTranscript);

      if (!reusedPressure.requiresSynchronousCompaction) {
        return reused;
      }
    }

    const boundary = await loadForegroundCompactionBoundary(userId, threadId, latestUserMessageId);

    if (!boundary) throw new Error("prompt is too long: no compactable history before latest user");

    const result = await compactConversationSynchronously({
      userId,
      threadId,
      throughWatermark: boundary.compaction,
      // The estimate of the tail counts the rendered turn contexts.
      replayTail: projectModelTranscript(replayTail),
      replayTailWatermark: boundary.replayTail,
      attribution: { userId, runId, stepId, attempt, sessionId: threadId },
      abortSignal,
      timeoutMs: FOREGROUND_COMPACTION_TIMEOUT_MS,
    });

    const winningSummary =
      result.kind === "persisted"
        ? result.summary
        : (await loadChatThreadContext(userId, threadId))?.summary;

    if (!winningSummary) {
      throw new Error("prompt is too long: synchronous compaction lost without a valid winner");
    }

    const rebuilt = buildCompactedChatTranscriptPair(
      conversationSummaryMessage(winningSummary),
      storedReplayTail,
      replayTail,
    );

    const rebuiltPressure = await assess(rebuilt.modelTranscript);

    if (!rebuiltPressure.requiresSynchronousCompaction) {
      return rebuilt;
    }

    const latestUser = replayTail[0];

    if (!latestUser || latestUser.role !== "user" || !latestUserMessageId) {
      throw new Error("prompt is too long after synchronous compaction");
    }

    let oversized: Awaited<ReturnType<typeof compactTranscript>>;

    try {
      oversized = await compactTranscript({
        prior: storedCompactionPrefix(storedReplayTail, 1),
        inFlightTail: [],
        attribution: {
          userId,
          runId,
          stepId,
          attempt,
          idempotencyKey: `${stepId}:oversized-user-message`,
          sessionId: threadId,
          name: "chat.oversized-user-message-summary",
        },
        abortSignal,
        timeoutMs: FOREGROUND_COMPACTION_TIMEOUT_MS,
      });
    } catch (error) {
      if (toMessage(error) === "compactor_input_too_large") {
        throw new Error("prompt is too long: latest user message exceeds compactor input", {
          cause: error,
        });
      }

      throw error;
    }

    const oversizedMessage = oversizedUserMessageSummaryMessage(
      latestUserMessageId,
      oversized.raw.text,
    );

    const boundedModelTail = [oversizedMessage, ...replayTail.slice(1)];
    const boundedStoredTail = [oversizedMessage, ...storedReplayTail.slice(1)];

    const bounded = buildCompactedChatTranscriptPair(
      conversationSummaryMessage(winningSummary),
      boundedStoredTail,
      boundedModelTail,
    );

    const boundedPressure = await assess(bounded.modelTranscript);

    if (boundedPressure.requiresSynchronousCompaction) {
      throw new Error("prompt is too long after oversized user message summarization");
    }

    return bounded;
  } finally {
    await onCompactionFinish?.();
  }
}

async function applyWithinRunContextGuard({
  userId,
  runId,
  stepId,
  attempt,
  systemPrompt,
  tools,
  model,
  transcript,
  hydratedTranscript,
  inFlightTailStart,
  projectModelTranscript,
  pendingGuidance,
  abortSignal,
  onCompactionStart,
  onCompactionFinish,
}: {
  userId: string;
  runId: string;
  stepId: string;
  attempt: number;
  systemPrompt: string;
  tools: ToolSet;
  model: LanguageModel;
  transcript: readonly TranscriptMessage[];
  hydratedTranscript: readonly TranscriptMessage[];
  inFlightTailStart: number;
  projectModelTranscript: TurnContextProjection;
  pendingGuidance: TranscriptMessage | undefined;
  abortSignal: AbortSignal;
  onCompactionStart?: () => Promise<void>;
  onCompactionFinish?: () => Promise<void>;
}): Promise<{
  modelTranscript: TranscriptMessage[];
  continuationTranscript: TranscriptMessage[];
  compacted: boolean;
}> {
  const contextWindowTokens = await resolveModelContextWindow(model);

  const assess = (candidate: readonly TranscriptMessage[]) =>
    assessChatRequestPressure({
      systemPrompt,
      tools,
      transcript: pendingGuidance
        ? [...projectModelTranscript(candidate), pendingGuidance]
        : projectModelTranscript(candidate),
      contextWindowTokens,
      outputReserveTokens: CHAT_MAX_OUTPUT_TOKENS,
    });

  const pressure = await assess(hydratedTranscript);

  if (!pressure.requiresSynchronousCompaction) {
    return {
      modelTranscript: [...hydratedTranscript],
      continuationTranscript: [...transcript],
      compacted: false,
    };
  }

  if (inFlightTailStart <= 0 || inFlightTailStart >= transcript.length) {
    throw new Error("prompt is too long: no within-run history can be compacted safely");
  }

  await onCompactionStart?.();

  try {
    const prior = storedCompactionPrefix(transcript, inFlightTailStart);
    const inFlightTail = hydratedTranscript.slice(inFlightTailStart);
    const storedInFlightTail = transcript.slice(inFlightTailStart);

    // No delay: a live turn waits. A stop is fatal too: nobody waits for that turn.
    const compacted = await compactWithRetry(
      (retry) =>
        compactTranscript({
          prior,
          inFlightTail,
          attribution: {
            userId,
            runId,
            stepId,
            attempt,
            idempotencyKey: `${stepId}:chat-within-run-${retry}`,
            name: "chat.within-run-compaction",
          },
          abortSignal,
          timeoutMs: FOREGROUND_COMPACTION_TIMEOUT_MS,
        }),
      { abortSignal },
    );

    const postPressure = await assess(compacted.transcript);

    if (postPressure.requiresSynchronousCompaction) {
      throw new Error("prompt is too long after within-run compaction");
    }

    return {
      ...buildCompactedChatTranscriptPair(
        compacted.summary,
        storedInFlightTail,
        compacted.transcript.slice(1),
      ),
      compacted: true,
    };
  } finally {
    await onCompactionFinish?.();
  }
}

/**
 * Compact before the model call when needed. The caller injects `onPhase` and
 * handles a stop; this only propagates the abort.
 */
async function guardExistingTurnContext(args: {
  turnCount: number;
  inFlightTailStart: number;
  userId: string;
  runId: string;
  stepId: string;
  attempt: number;
  threadId: string;
  latestUserMessageId: string | undefined;
  systemPrompt: string;
  tools: ToolSet;
  model: LanguageModel;
  storedTranscript: readonly TranscriptMessage[];
  hydratedTranscript: readonly TranscriptMessage[];
  /** Renders the saved turn contexts on a replay window (ADR-0130 amendment (g)). */
  projectModelTranscript: TurnContextProjection;
  pendingGuidance?: TranscriptMessage | undefined;
  abortSignal: AbortSignal;
  onPhase: (
    phase: "compaction_started" | "compaction_finished",
    scope: "foreground" | "within_run",
  ) => Promise<void>;
}): Promise<{
  continuationTranscript: TranscriptMessage[];
  modelTranscript: TranscriptMessage[];
  compacted: boolean;
}> {
  // Otherwise the loaded transcript is already bounded.
  if (!(args.turnCount === 1 || args.inFlightTailStart > 0)) {
    return {
      continuationTranscript: [...args.storedTranscript],
      modelTranscript: [...args.hydratedTranscript],
      compacted: false,
    };
  }

  const guardAbortSignal = AbortSignal.any([
    args.abortSignal,
    AbortSignal.timeout(FOREGROUND_COMPACTION_TIMEOUT_MS),
  ]);

  if (args.turnCount === 1) {
    const foreground = await applyForegroundContextGuard({
      userId: args.userId,
      runId: args.runId,
      stepId: args.stepId,
      attempt: args.attempt,
      threadId: args.threadId,
      latestUserMessageId: args.latestUserMessageId,
      systemPrompt: args.systemPrompt,
      tools: args.tools,
      model: args.model,
      storedTranscript: args.storedTranscript,
      hydratedTranscript: args.hydratedTranscript,
      projectModelTranscript: args.projectModelTranscript,
      pendingGuidance: args.pendingGuidance,
      abortSignal: guardAbortSignal,
      onCompactionStart: () => args.onPhase("compaction_started", "foreground"),
      onCompactionFinish: () => args.onPhase("compaction_finished", "foreground"),
    });

    // Turn 1 has no tail to reset.
    return {
      continuationTranscript: foreground.continuationTranscript,
      modelTranscript: foreground.modelTranscript,
      compacted: false,
    };
  }

  const withinRun = await applyWithinRunContextGuard({
    userId: args.userId,
    runId: args.runId,
    stepId: args.stepId,
    attempt: args.attempt,
    systemPrompt: args.systemPrompt,
    tools: args.tools,
    model: args.model,
    transcript: args.storedTranscript,
    hydratedTranscript: args.hydratedTranscript,
    inFlightTailStart: args.inFlightTailStart,
    projectModelTranscript: args.projectModelTranscript,
    pendingGuidance: args.pendingGuidance,
    abortSignal: guardAbortSignal,
    onCompactionStart: () => args.onPhase("compaction_started", "within_run"),
    onCompactionFinish: () => args.onPhase("compaction_finished", "within_run"),
  });

  return {
    continuationTranscript: withinRun.continuationTranscript,
    modelTranscript: withinRun.modelTranscript,
    compacted: withinRun.compacted,
  };
}

/**
 * Admit pending guidance only after compaction, in both checkpoint and model views. The model view
 * is the projection of the final window: each user message gets its saved turn context there, and
 * nowhere else (ADR-0130 amendment (g)).
 */
export async function guardTurnContext(args: Parameters<typeof guardExistingTurnContext>[0]) {
  const guarded = await guardExistingTurnContext(args);
  const modelTranscript = args.projectModelTranscript(guarded.modelTranscript);

  if (!args.pendingGuidance) return { ...guarded, modelTranscript };

  return {
    ...guarded,
    continuationTranscript: [...guarded.continuationTranscript, args.pendingGuidance],
    modelTranscript: [...modelTranscript, args.pendingGuidance],
  };
}
