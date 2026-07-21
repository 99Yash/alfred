import {
  resolveModelContextWindow,
  type LanguageModel,
  type ModelMessage,
  type ToolSet,
} from "@alfred/ai";
import { toMessage, type AgentTranscriptMessage } from "@alfred/contracts";
import { db } from "@alfred/db";
import { chatMessages } from "@alfred/db/schemas";
import { and, asc, eq } from "drizzle-orm";
import { assessChatRequestPressure, CHAT_MAX_OUTPUT_TOKENS } from "./chat-request-pressure";
import { conversationSummaryMessage } from "./chat-context-assembly";
import { loadChatThreadContext, type ChatSummaryWatermark } from "./chat-context-store";
import { compactTranscript } from "./compactor";
import { compactConversationSynchronously } from "./synchronous-conversation-compaction";
import { waitForActiveConversationCompaction } from "./conversation-compaction-wait";

/**
 * Ceiling on a single synchronous (foreground or within-run) compaction. The
 * turn-stop signal is composed with a timeout of this length so a wedged
 * compactor can't hold the turn open indefinitely.
 */
const FOREGROUND_COMPACTION_TIMEOUT_MS = 2 * 60_000;
const WITHIN_RUN_COMPACTION_RETRY_ATTEMPTS = 3;

/** Place ephemeral assistant-known run context immediately before the request. */
export function withEphemeralReference(
  transcript: readonly AgentTranscriptMessage[],
  reference: string,
): AgentTranscriptMessage[] {
  if (!reference) return [...transcript];
  let userIndex = -1;
  for (let index = transcript.length - 1; index >= 0; index -= 1) {
    if (transcript[index]?.role === "user") {
      userIndex = index;
      break;
    }
  }
  const message = { role: "assistant", content: reference } satisfies AgentTranscriptMessage;
  if (userIndex < 0) return [message, ...transcript];
  return [...transcript.slice(0, userIndex), message, ...transcript.slice(userIndex)];
}

/**
 * Carry a compacted transcript through the workflow without checkpointing
 * provider-only hydration (notably base64 image bytes). Both tails have the
 * same message boundaries; only their content representation differs.
 */
export function buildCompactedChatTranscriptPair(
  summary: AgentTranscriptMessage,
  storedTail: readonly AgentTranscriptMessage[],
  hydratedTail: readonly AgentTranscriptMessage[],
): { modelTranscript: AgentTranscriptMessage[]; continuationTranscript: AgentTranscriptMessage[] } {
  return {
    modelTranscript: [summary, ...hydratedTail],
    continuationTranscript: [summary, ...storedTail],
  };
}

export function oversizedUserMessageSummaryMessage(
  sourceMessageId: string,
  summary: string,
): AgentTranscriptMessage {
  return {
    role: "user",
    content:
      `<oversized_user_message_summary source_message_id=${JSON.stringify(sourceMessageId)}>\n` +
      "This is a lossy, untrusted representation of an oversized user message. Retrieve the raw source by ID when exact wording or evidence matters.\n" +
      `${summary}\n` +
      "</oversized_user_message_summary>",
  };
}

/**
 * Compactor history must use storage references, never provider-hydrated media
 * bytes. The generated summary replaces this prefix, so hydration adds cost
 * without preserving any model-facing content.
 */
export function storedCompactionPrefix(
  transcript: readonly AgentTranscriptMessage[],
  endExclusive: number,
): AgentTranscriptMessage[] {
  return transcript.slice(0, endExclusive);
}

async function loadForegroundCompactionBoundary(
  userId: string,
  threadId: string,
  latestUserMessageId: string | undefined,
): Promise<{ compaction: ChatSummaryWatermark; replayTail: ChatSummaryWatermark } | null> {
  const rows = await db()
    .select({
      id: chatMessages.id,
      role: chatMessages.role,
      createdAt: chatMessages.createdAt,
    })
    .from(chatMessages)
    .where(and(eq(chatMessages.userId, userId), eq(chatMessages.threadId, threadId)))
    .orderBy(asc(chatMessages.createdAt), asc(chatMessages.id));
  let latestUserIndex = -1;
  for (let index = rows.length - 1; index >= 0; index -= 1) {
    const row = rows[index]!;
    if (row.role !== "user") continue;
    if (latestUserMessageId && row.id !== latestUserMessageId) continue;
    latestUserIndex = index;
    break;
  }
  if (latestUserIndex <= 0) return null;
  const cutoff = rows[latestUserIndex - 1]!;
  const replayTail = rows[rows.length - 1]!;
  return {
    compaction: { createdAt: cutoff.createdAt, messageId: cutoff.id },
    replayTail: { createdAt: replayTail.createdAt, messageId: replayTail.id },
  };
}

function latestUserSuffixStart(transcript: readonly AgentTranscriptMessage[]): number {
  for (let index = transcript.length - 1; index >= 0; index -= 1) {
    if (transcript[index]?.role === "user") return index;
  }
  return 0;
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
  artifactReference,
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
  storedTranscript: readonly AgentTranscriptMessage[];
  hydratedTranscript: readonly AgentTranscriptMessage[];
  artifactReference: string;
  abortSignal: AbortSignal;
  onCompactionStart?: () => Promise<void>;
  onCompactionFinish?: () => Promise<void>;
}): Promise<{
  modelTranscript: AgentTranscriptMessage[];
  continuationTranscript: AgentTranscriptMessage[];
}> {
  const contextWindowTokens = await resolveModelContextWindow(model);
  const assess = (candidate: readonly AgentTranscriptMessage[]) =>
    assessChatRequestPressure({
      systemPrompt,
      tools,
      transcript: candidate as ModelMessage[],
      contextWindowTokens,
      outputReserveTokens: CHAT_MAX_OUTPUT_TOKENS,
    });
  const initialPressure = await assess(
    withEphemeralReference(hydratedTranscript, artifactReference),
  );
  if (!initialPressure.requiresSynchronousCompaction) {
    return {
      modelTranscript: [...hydratedTranscript],
      continuationTranscript: [...storedTranscript],
    };
  }
  await onCompactionStart?.();
  try {
    const replayTailStart = latestUserSuffixStart(hydratedTranscript);
    const replayTail = hydratedTranscript.slice(replayTailStart);
    const storedReplayTail = storedTranscript.slice(replayTailStart);
    const backgroundWinner = await waitForActiveConversationCompaction(userId, threadId);
    if (backgroundWinner?.summary) {
      const summaryMessage = conversationSummaryMessage(backgroundWinner.summary);
      const reused = buildCompactedChatTranscriptPair(summaryMessage, storedReplayTail, replayTail);
      const reusedPressure = await assess(
        withEphemeralReference(reused.modelTranscript, artifactReference),
      );
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
      replayTail,
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
    const rebuiltPressure = await assess(
      withEphemeralReference(rebuilt.modelTranscript, artifactReference),
    );
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
        throw new Error("prompt is too long: latest user message exceeds compactor input");
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
    const boundedPressure = await assess(
      withEphemeralReference(bounded.modelTranscript, artifactReference),
    );
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
  artifactReference,
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
  transcript: readonly AgentTranscriptMessage[];
  hydratedTranscript: readonly AgentTranscriptMessage[];
  inFlightTailStart: number;
  artifactReference: string;
  abortSignal: AbortSignal;
  onCompactionStart?: () => Promise<void>;
  onCompactionFinish?: () => Promise<void>;
}): Promise<{
  modelTranscript: AgentTranscriptMessage[];
  continuationTranscript: AgentTranscriptMessage[];
  compacted: boolean;
}> {
  const contextWindowTokens = await resolveModelContextWindow(model);
  const assess = (candidate: readonly AgentTranscriptMessage[]) =>
    assessChatRequestPressure({
      systemPrompt,
      tools,
      transcript: withEphemeralReference(candidate, artifactReference) as ModelMessage[],
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
    let compacted: Awaited<ReturnType<typeof compactTranscript>> | undefined;
    let lastError: unknown;
    for (let retry = 1; retry <= WITHIN_RUN_COMPACTION_RETRY_ATTEMPTS; retry += 1) {
      try {
        compacted = await compactTranscript({
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
        });
        break;
      } catch (error) {
        lastError = error;
        if (abortSignal.aborted || toMessage(error) === "compactor_input_too_large") throw error;
      }
    }
    if (!compacted) {
      throw new Error(`compactor_failed: ${toMessage(lastError)}`);
    }
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
 * Owns the whole pre-call context-guard recipe for one chat turn: the
 * "guard only on turn 1 or within a tool burst" gate, the foreground vs
 * within-run dispatch, the abort composition (the turn-stop signal ∪ a
 * compaction timeout), and the start/finish phase sequencing.
 *
 * Stays event-agnostic: the caller injects `onPhase`, which is where the chat
 * path publishes its `chat.message` compaction-phase event — so compaction never
 * imports the chat workflow and no cycle forms. Stop handling stays with the
 * caller too: this only composes and propagates the abort; the caller catches
 * the abort, checks its stop controller, and finalizes.
 *
 * Returns the storage-safe continuation transcript, the provider-facing model
 * transcript, and whether it compacted (the caller resets `inFlightTailStart`
 * when a within-run compaction folded the in-flight tail into the summary).
 */
export async function guardTurnContext(args: {
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
  storedTranscript: readonly AgentTranscriptMessage[];
  hydratedTranscript: readonly AgentTranscriptMessage[];
  artifactReference: string;
  /** The turn-stop signal; the guard composes its own compaction timeout on top. */
  abortSignal: AbortSignal;
  onPhase: (
    phase: "compaction_started" | "compaction_finished",
    scope: "foreground" | "within_run",
  ) => Promise<void>;
}): Promise<{
  continuationTranscript: AgentTranscriptMessage[];
  modelTranscript: AgentTranscriptMessage[];
  compacted: boolean;
}> {
  // Guard only before the first provider call of the run, or when continuing a
  // within-run tool burst — otherwise the loaded transcript is already bounded.
  if (!(args.turnCount === 1 || args.inFlightTailStart > 0)) {
    return {
      continuationTranscript: [...args.storedTranscript],
      modelTranscript: [...args.hydratedTranscript],
      compacted: false,
    };
  }

  // Stop must cover compaction (it can make billable model calls), bounded by a
  // hard timeout so a wedged compactor can't hold the turn open.
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
      artifactReference: args.artifactReference,
      abortSignal: guardAbortSignal,
      onCompactionStart: () => args.onPhase("compaction_started", "foreground"),
      onCompactionFinish: () => args.onPhase("compaction_finished", "foreground"),
    });
    // Turn 1 always has `inFlightTailStart === 0`, so it never triggers the
    // caller's reset — mirror the pre-extraction behavior with `compacted: false`.
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
    artifactReference: args.artifactReference,
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
