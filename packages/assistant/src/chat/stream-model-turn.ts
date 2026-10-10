import type { AlfredAgent } from "@alfred/ai";
import { getStringPath, type ToolName } from "@alfred/contracts";
import { CHAT_DELTA_MAX } from "@alfred/contracts/events";
import { parsePartialJson } from "ai";
import { publishEvent } from "@alfred/assistant/triggers";
import {
  shouldPublishToolStarted,
  toolCardStarted,
  type StepContext,
} from "@alfred/assistant/execution";
import { createVoiceStreamSanitizer } from "@alfred/ai/voice";
import type { TurnStopController } from "./turn-stop-controller";

/** Flush coalesced text/reasoning/artifact deltas at least this often (ms) and at this size (chars). */
const DELTA_FLUSH_MS = 180;

const DELTA_FLUSH_CHARS = 100;

/**
 * How a tool's streamed `markdown` lands: `replace` is the whole body, `append` a new section.
 * `append_artifact_page` is absent: pages already appear one page at a time.
 */
type ArtifactStreamMode = "replace" | "append";

function artifactStreamMode(toolName: string): ArtifactStreamMode | undefined {
  switch (toolName) {
    case "system.create_artifact":
    case "system.update_artifact":
      return "replace";
    case "system.append_artifact_section":
      return "append";
    default:
      return undefined;
  }
}

function splitEventText(text: string): string[] {
  const chunks: string[] = [];

  for (let i = 0; i < text.length; i += CHAT_DELTA_MAX) {
    chunks.push(text.slice(i, i + CHAT_DELTA_MAX));
  }

  return chunks;
}

/** The slice of `ChatRunState` the drain mutates. Structural, so this module does not import the workflow. */
export interface StreamTurnState {
  threadId: string;
  messageId: string;
  activeTools: readonly ToolName[];
  segmentIndex: number;
  reissuePending: boolean;
  assistantText: string;
  reasoningText: string;
  reasoningMs: number;
  deltaSeq: number;
  reasoningSeq: number;
}

/** What a drained stream hands back to the turn that owns it. */
export interface StreamedTurn {
  /**
   * Publish the reply the #407 gate withheld, then the sanitizer tail, in that order.
   * A no-op until the caller clears `state.reissuePending`.
   */
  releaseWithheldReply(): Promise<void>;
}

/**
 * Drain one live stream into `chat.delta`, `chat.reasoning`, `chat.tool` started
 * cards, and `artifact.delta`. Mutates `state` in place.
 */
export async function streamModelTurn(args: {
  stream: Awaited<ReturnType<AlfredAgent["streamTurn"]>>;
  /** A copy of `ctx.state`, never `ctx.state` itself: the frames read their `fromSeq` from `ctx.state`. */
  state: StreamTurnState;
  /** `ctx.state` is the committed state, so its seqs are this attempt's `fromSeq`. */
  ctx: Pick<
    StepContext<Pick<StreamTurnState, "deltaSeq" | "reasoningSeq">>,
    "userId" | "runId" | "attempt" | "state"
  >;
  stopController: TurnStopController;
  /** Injected for tests. */
  publish?: typeof publishEvent;
}): Promise<StreamedTurn> {
  const { stream, state, ctx, stopController, publish = publishEvent } = args;

  // Same transform as the `sanitizeVoice` on the saved row, so the stream matches the final bubble.
  const voiceSanitizer = createVoiceStreamSanitizer();
  let buffer = "";
  let lastFlush = Date.now();

  const publishTextDelta = async (text: string): Promise<void> => {
    for (const chunk of splitEventText(text)) {
      state.deltaSeq += 1;
      await publish({
        untransacted: true,
        userId: ctx.userId,
        kind: "chat.delta",
        payload: {
          runId: ctx.runId,
          threadId: state.threadId,
          messageId: state.messageId,
          seq: state.deltaSeq,
          attempt: ctx.attempt,
          fromSeq: ctx.state.deltaSeq,
          text: chunk,
          segmentIndex: state.segmentIndex,
        },
      });
    }
  };

  const flush = async (): Promise<void> => {
    // Withhold a #407 reissue lead-in. Keep `buffer`: if the model answers instead, it is released.
    if (state.reissuePending) return;

    if (buffer.length === 0) return;
    // `push` may hold back a trailing dash or space; `flushVoiceTail` releases it.
    const text = voiceSanitizer.push(buffer);
    buffer = "";
    lastFlush = Date.now();

    if (text.length === 0) return;
    await publishTextDelta(text);
  };

  const flushVoiceTail = async (): Promise<void> => {
    if (state.reissuePending) return;
    const tail = voiceSanitizer.flush();

    if (tail.length > 0) await publishTextDelta(tail);
  };

  let reasoningBuffer = "";
  let lastReasoningFlush = Date.now();
  // For "Thought for Ns". Reasoning can resume after a tool, so it accumulates.
  let reasoningStart = 0;

  const flushReasoning = async (): Promise<void> => {
    if (reasoningBuffer.length === 0) return;
    const text = reasoningBuffer;
    reasoningBuffer = "";
    lastReasoningFlush = Date.now();

    for (const chunk of splitEventText(text)) {
      state.reasoningSeq += 1;
      await publish({
        untransacted: true,
        userId: ctx.userId,
        kind: "chat.reasoning",
        payload: {
          runId: ctx.runId,
          threadId: state.threadId,
          messageId: state.messageId,
          seq: state.reasoningSeq,
          attempt: ctx.attempt,
          fromSeq: ctx.state.reasoningSeq,
          text: chunk,
        },
      });
    }
  };

  // Stream a document's `markdown` argument from its partial JSON, so the sidebar fills live.
  // Keyed by toolCallId: create_artifact has no artifact id until it runs.
  interface ArtifactInputStream {
    mode: "replace" | "append";
    buf: string;
    sentLen: number;
    seq: number;
    lastFlush: number;
    titleSent: boolean;
  }

  const artifactInputs = new Map<string, ArtifactInputStream>();

  const flushArtifactInput = async (toolCallId: string, final: boolean): Promise<void> => {
    const s = artifactInputs.get(toolCallId);

    if (!s) return;

    if (final) artifactInputs.delete(toolCallId);
    const parsed = await parsePartialJson(s.buf);
    const value = parsed.value;
    const markdown = getStringPath(value, "markdown") ?? "";

    // This also skips a `pages` create and a rename-only update.
    if (markdown.length <= s.sentLen) return;
    const title = getStringPath(value, "title");

    const artifactId = getStringPath(value, "artifactId");

    const tail = markdown.slice(s.sentLen);
    s.sentLen = markdown.length;
    s.lastFlush = Date.now();

    // An event over CHAT_DELTA_MAX would throw and fault the turn, so chunk it.
    for (const [i, chunk] of splitEventText(tail).entries()) {
      s.seq += 1;
      const includeTitle = i === 0 && !s.titleSent && title !== undefined;

      if (includeTitle) s.titleSent = true;
      await publish({
        untransacted: true,
        userId: ctx.userId,
        kind: "artifact.delta",
        payload: {
          runId: ctx.runId,
          threadId: state.threadId,
          toolCallId,
          seq: s.seq,
          text: chunk,
          mode: s.mode,
          ...(includeTitle ? { title } : {}),
          ...(artifactId ? { artifactId } : {}),
        },
      });
    }
  };

  try {
    for await (const part of stream.stream) {
      if (await stopController.checkStop()) break;

      if (part.type === "tool-input-start") {
        // Here `part.id` is the toolCallId.
        const mode = artifactStreamMode(part.toolName);

        if (mode) {
          artifactInputs.set(part.id, {
            mode,
            buf: "",
            sentLen: 0,
            seq: 0,
            lastFlush: Date.now(),
            titleSent: false,
          });
        }
      } else if (part.type === "tool-input-delta") {
        const s = artifactInputs.get(part.id);

        if (s) {
          s.buf += part.delta;

          if (
            s.buf.length - s.sentLen >= DELTA_FLUSH_CHARS ||
            Date.now() - s.lastFlush >= DELTA_FLUSH_MS
          ) {
            await flushArtifactInput(part.id, false);
          }
        }
      } else if (part.type === "text-delta") {
        await flushReasoning();
        state.assistantText += part.text;
        buffer += part.text;

        if (buffer.length >= DELTA_FLUSH_CHARS || Date.now() - lastFlush >= DELTA_FLUSH_MS) {
          await flush();
        }
      } else if (part.type === "reasoning-delta") {
        if (reasoningStart === 0) reasoningStart = Date.now();
        state.reasoningText += part.text;
        reasoningBuffer += part.text;

        if (
          reasoningBuffer.length >= DELTA_FLUSH_CHARS ||
          Date.now() - lastReasoningFlush >= DELTA_FLUSH_MS
        ) {
          await flushReasoning();
        }
      } else if (part.type === "reasoning-end") {
        if (reasoningStart > 0) state.reasoningMs += Date.now() - reasoningStart;
        reasoningStart = 0;
        await flushReasoning();
      } else if (part.type === "tool-call") {
        if (reasoningStart > 0) {
          state.reasoningMs += Date.now() - reasoningStart;
          reasoningStart = 0;
        }

        await flushReasoning();
        await flush();

        // Publish the rest of the body before the tool runs.
        if (artifactInputs.has(part.toolCallId)) {
          await flushArtifactInput(part.toolCallId, true);
        }

        if (shouldPublishToolStarted(state.activeTools, part.toolName)) {
          await publish({
            untransacted: true,
            userId: ctx.userId,
            kind: "chat.tool",
            payload: toolCardStarted(
              { runId: ctx.runId, threadId: state.threadId, messageId: state.messageId },
              part,
              state.segmentIndex,
            ),
          });
        }
      } else if (part.type === "error") {
        // Some providers report our own stop-abort here; that is not a fault.
        if (stopController.stopped) break;
        throw part.error instanceof Error ? part.error : new Error(String(part.error));
      }
    }
  } catch (err) {
    // The stop-abort can also throw from the iterator. Swallow it only after a stop.
    if (!stopController.stopped) throw err;
  }

  // Some providers end the stream without a `reasoning-end`; close the duration
  // and flush any trailing thinking before the reply flush.
  if (reasoningStart > 0) {
    state.reasoningMs += Date.now() - reasoningStart;
    reasoningStart = 0;
  }

  await flushReasoning();
  await flush();
  // Before the caller bumps the segment, so the tail lands on this one.
  await flushVoiceTail();

  return {
    releaseWithheldReply: async () => {
      await flush();
      await flushVoiceTail();
    },
  };
}
