import type { AlfredAgent } from "@alfred/ai";
import { isRecord, type ToolName } from "@alfred/contracts";
import { CHAT_DELTA_MAX } from "@alfred/contracts/events";
import { parsePartialJson } from "ai";
import { publishEvent } from "../../../events/publish";
import { createVoiceStreamSanitizer } from "../voice-sanitize";
import { preview } from "./tool-preview";
import type { TurnStopController } from "./turn-stop-controller";

/** Flush coalesced text/reasoning/artifact deltas at least this often (ms) and at this size (chars). */
const DELTA_FLUSH_MS = 180;
const DELTA_FLUSH_CHARS = 100;

/**
 * The document-authoring tools whose `markdown` argument we stream live as
 * `artifact.delta` (see the stream loop). `replace` means the streamed markdown
 * is the whole body (create seeds it, update replaces it); `append` means it is
 * a new section rendered after the existing synced content. `append_artifact_page`
 * is absent — `pages`/HTML artifacts already appear at page granularity.
 */
const ARTIFACT_STREAM_MODES: Readonly<Record<string, "replace" | "append">> = {
  "system.create_artifact": "replace",
  "system.update_artifact": "replace",
  "system.append_artifact_section": "append",
};

function splitEventText(text: string): string[] {
  const chunks: string[] = [];
  for (let i = 0; i < text.length; i += CHAT_DELTA_MAX) {
    chunks.push(text.slice(i, i + CHAT_DELTA_MAX));
  }
  return chunks;
}

export function shouldPublishToolStarted(
  activeTools: readonly ToolName[],
  toolName: string,
): boolean {
  return activeTools.some((activeTool) => activeTool === toolName);
}

/**
 * The mutable slice of `ChatRunState` the stream drain owns. Kept as a narrow
 * structural contract (like the injected args of `tool-round`) rather than an
 * import of `ChatRunState`, so this deep module stays decoupled from the chat
 * workflow — the full state is structurally assignable to it.
 */
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

/**
 * Drain one live `streamTurn` stream: coalesce reply text into `chat.delta`,
 * reasoning into `chat.reasoning`, surface each tool call as a `chat.tool`
 * started card, and stream a document artifact's `markdown` argument live as
 * `artifact.delta`. Extracted from `chat-turn`'s step body so the four stream
 * machines (voice/text flush, reasoning flush, artifact-input stream, and the
 * `for await` drain) are testable against a fake async-iterable stream and the
 * step body reads as orchestration.
 *
 * Mutates `state` in place (assistantText, reasoningText, reasoningMs, deltaSeq,
 * reasoningSeq) and reads its `reissuePending` / `activeTools` / `segmentIndex`.
 * Returns `flushReply`/`flushReplyTail` bound to this module's internal text
 * buffer + voice sanitizer: while a reissue is pending (#407) the reply flush is
 * withheld, so the step body's reissue→answer branch calls these to release the
 * deltas the gate held back once it has cleared `state.reissuePending`.
 */
export async function streamModelTurn(args: {
  stream: Awaited<ReturnType<AlfredAgent["streamTurn"]>>;
  state: StreamTurnState;
  ctx: { userId: string; runId: string };
  stopController: TurnStopController;
  /**
   * Event sink, injected for tests. Defaults to the real outbox publisher; the
   * call site never overrides it, so production behavior is unchanged. Tests
   * pass a capturing stub to assert the emitted `chat.delta` / `chat.reasoning`
   * / `chat.tool` / `artifact.delta` sequence without a live DB.
   */
  publish?: typeof publishEvent;
}): Promise<{ flushReply(): Promise<void>; flushReplyTail(): Promise<void> }> {
  const { stream, state, ctx, stopController, publish = publishEvent } = args;

  // Enforce the deterministic half of DEFAULT_VOICE_PROMPT ("No em-dashes") on
  // the live stream, not just the persisted row. One sanitizer per streamTurn
  // (one prose segment): coalesced deltas run through it before publishing. It
  // is chunk-invariant and shares its lexical transform with the batch
  // `sanitizeVoice` that finalize applies to `content`/`narration`, so the
  // streamed text equals the reconciled bubble exactly — no mid-stream em-dash
  // that "corrects itself" on completion. Code, quotations, links, and
  // identifiers are preserved verbatim.
  const voiceSanitizer = createVoiceStreamSanitizer();
  let buffer = "";
  let lastFlush = Date.now();
  const publishTextDelta = async (text: string): Promise<void> => {
    for (const chunk of splitEventText(text)) {
      state.deltaSeq += 1;
      await publish({
        userId: ctx.userId,
        kind: "chat.delta",
        payload: {
          runId: ctx.runId,
          threadId: state.threadId,
          messageId: state.messageId,
          seq: state.deltaSeq,
          text: chunk,
          segmentIndex: state.segmentIndex,
        },
      });
    }
  };
  const flush = async (): Promise<void> => {
    // While a reissue is pending (#407) this turn's text is an internal reissue
    // lead-in — withhold its live deltas so "tools warming up, retrying" never
    // streams. Keep `buffer` intact and the sanitizer untouched: if the model
    // answers instead of reissuing, the final-answer path clears the flag and
    // flushes it as the real reply.
    if (state.reissuePending) return;
    if (buffer.length === 0) return;
    // `push` may hold back a trailing dash/space until the next chunk fixes its
    // meaning; `flushVoiceTail` releases the remainder after the drain.
    const text = voiceSanitizer.push(buffer);
    buffer = "";
    lastFlush = Date.now();
    if (text.length === 0) return;
    await publishTextDelta(text);
  };
  // Release whatever the streaming sanitizer held back, closing the segment's
  // live text. Safe on an empty sanitizer (returns ""). Gated on
  // `reissuePending` for the same reason as `flush`.
  const flushVoiceTail = async (): Promise<void> => {
    if (state.reissuePending) return;
    const tail = voiceSanitizer.flush();
    if (tail.length > 0) await publishTextDelta(tail);
  };

  let reasoningBuffer = "";
  let lastReasoningFlush = Date.now();
  // First/last reasoning token timestamps → "Thought for Ns". Accumulates
  // across turns in a tool-calling loop (reasoning can resume after a tool).
  let reasoningStart = 0;
  const flushReasoning = async (): Promise<void> => {
    if (reasoningBuffer.length === 0) return;
    const text = reasoningBuffer;
    reasoningBuffer = "";
    lastReasoningFlush = Date.now();
    for (const chunk of splitEventText(text)) {
      state.reasoningSeq += 1;
      await publish({
        userId: ctx.userId,
        kind: "chat.reasoning",
        payload: {
          runId: ctx.runId,
          threadId: state.threadId,
          messageId: state.messageId,
          seq: state.reasoningSeq,
          text: chunk,
        },
      });
    }
  };

  // --- Live artifact-body streaming (document markdown) ---
  // A `document` artifact's body is the `markdown` argument of
  // create_artifact / append_artifact_section / update_artifact. The SDK
  // streams that argument incrementally as `tool-input-delta` parts while the
  // model generates, so we accumulate the raw partial-JSON per toolCallId,
  // extract the growing `markdown` string, and publish its growth as
  // `artifact.delta` — letting the sidebar fill live instead of popping in whole
  // when the tool executes. Keyed by toolCallId because create_artifact has no
  // artifact id until it runs. `pages`/HTML tools are deliberately excluded
  // (they already appear at page granularity, and a create with no `markdown`
  // field simply never emits).
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
    const markdown = isRecord(value) && typeof value.markdown === "string" ? value.markdown : "";
    // Only publish once the body has actually grown — this is what excludes a
    // `pages` create (no `markdown` field) and a rename-only update.
    if (markdown.length <= s.sentLen) return;
    const title = isRecord(value) && typeof value.title === "string" ? value.title : undefined;
    const artifactId =
      isRecord(value) && typeof value.artifactId === "string" ? value.artifactId : undefined;
    const tail = markdown.slice(s.sentLen);
    s.sentLen = markdown.length;
    s.lastFlush = Date.now();
    // Chunk the tail like chat deltas (splitEventText): the reducer appends each
    // `text`, so a big final burst — or a single >16k tool-input-delta — becomes
    // several in-cap events instead of one over-cap payload that `publishEvent`
    // would reject (its schema caps `text` at CHAT_DELTA_MAX), which would throw
    // inside the stream loop and fault the turn.
    for (const [i, chunk] of splitEventText(tail).entries()) {
      s.seq += 1;
      const includeTitle = i === 0 && !s.titleSent && title !== undefined;
      if (includeTitle) s.titleSent = true;
      await publish({
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
        // At the fullStream level, `part.id` is the toolCallId (it matches the
        // later `tool-call` part's `toolCallId`).
        const mode = ARTIFACT_STREAM_MODES[part.toolName];
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
        // The full tool call is assembled: publish the tail of any artifact body
        // it was streaming so the sidebar has the whole authored body before the
        // tool executes.
        if (artifactInputs.has(part.toolCallId)) {
          await flushArtifactInput(part.toolCallId, true);
        }
        if (shouldPublishToolStarted(state.activeTools, part.toolName)) {
          await publish({
            userId: ctx.userId,
            kind: "chat.tool",
            payload: {
              runId: ctx.runId,
              threadId: state.threadId,
              messageId: state.messageId,
              toolCallId: part.toolCallId,
              toolName: part.toolName,
              status: "started",
              argsPreview: preview(part.input),
              segmentIndex: state.segmentIndex,
            },
          });
        }
      } else if (part.type === "error") {
        // A mid-stream error (provider fault, timeout abort) surfaces here; throw
        // so the caller finalizes the turn as failed. Our own stop-abort can land
        // here too on some providers — not a fault.
        if (stopController.stopped) break;
        throw part.error instanceof Error ? part.error : new Error(String(part.error));
      }
    }
  } catch (err) {
    // The stop-abort can also surface as a thrown AbortError from the stream
    // iterator itself; swallow it only when we asked for it.
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
  // Segment complete: release any dash/whitespace the sanitizer held back so the
  // live text matches the persisted `sanitizeVoice(content)`. Runs before the
  // caller's stop/tool-call/final-answer branches so it lands on the current
  // segment index (a tool-call turn bumps the index only afterward).
  await flushVoiceTail();

  return { flushReply: flush, flushReplyTail: flushVoiceTail };
}
