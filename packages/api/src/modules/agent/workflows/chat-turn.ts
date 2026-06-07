import {
  AlfredAgent,
  classifyStreamFinish,
  getChatModel,
  getChatProviderOptions,
  getCheapModel,
  meteredGenerateText,
  tool,
  type ChatModelTier,
  type ModelMessage,
  type Tool,
  type ToolSet,
} from "@alfred/ai";
import { isIntegrationSlug, type AgentTranscriptMessage, type ToolName } from "@alfred/contracts";
import { db } from "@alfred/db";
import { chatMessages, chatThreads } from "@alfred/db/schemas";
import { CHAT_DELTA_MAX } from "@alfred/schemas/events";
import { and, asc, eq, ne, sql } from "drizzle-orm";
import { z } from "zod";
import { dispatchToolCall, type DispatchResult } from "../../dispatch";
import { emitReplicachePokes } from "../../../events/replicache-events";
import { publishEvent } from "../../../events/publish";
import { listToolsForIntegration } from "../../tools/registry";
import type { Step, Workflow } from "../types";

/**
 * Interactive streaming chat (streaming-chat plan). One run services one user
 * turn end-to-end: the agent streams its reply (token deltas + tool-call
 * cards over the SSE event bus), tools dispatch (writes gate through the
 * existing HIL/approval interrupt), and the finished assistant message is
 * persisted to `chat_messages` so it survives reload and reaches every device.
 *
 * Models: `standard` (Sonnet 4.6) by default; `deep` (Opus 4.6) escalation is
 * wired through state for a future heuristic / the boss-worker harness. The
 * agent can `system.load_integration` to reach email/calendar/etc and
 * `system.spawn_sub_agent` for focused fan-out — same tool surface as the boss.
 *
 * Not yet handled (deferred, noted): transcript compaction for very long
 * threads (relies on the 1M-context models for now) and auto Opus escalation.
 */
export const CHAT_TURN_WORKFLOW_SLUG = "__chat-turn__";

const TURN_CAP_MAX = 24;
/** Flush coalesced text deltas at least this often (ms) and at this size (chars). */
const DELTA_FLUSH_MS = 180;
const DELTA_FLUSH_CHARS = 100;
const PREVIEW_CHARS = 2_000;
const TITLE_TIMEOUT_MS = 15_000;

const pendingToolCallSchema = z.object({
  toolCallId: z.string().min(1),
  toolName: z.string().min(1),
  input: z.unknown(),
});
type PendingToolCall = z.infer<typeof pendingToolCallSchema>;

const toolCallLogSchema = z.object({
  toolCallId: z.string(),
  toolName: z.string(),
  status: z.enum(["succeeded", "failed"]),
  argsPreview: z.string().optional(),
  resultPreview: z.string().optional(),
});

const chatRunStateSchema = z.object({
  threadId: z.string().min(1),
  messageId: z.string().min(1),
  tier: z.enum(["standard", "deep"]),
  activeIntegrations: z.array(z.string().min(1)),
  allowedIntegrations: z.array(z.string()),
  pendingToolCalls: z.array(pendingToolCallSchema),
  assistantText: z.string().default(""),
  reasoningText: z.string().default(""),
  reasoningMs: z.number().int().min(0).default(0),
  toolCallsLog: z.array(toolCallLogSchema).default([]),
  deltaSeq: z.number().int().min(0).default(0),
  reasoningSeq: z.number().int().min(0).default(0),
  turnCount: z.number().int().min(0).default(0),
  started: z.boolean().default(false),
});
type ChatRunState = z.infer<typeof chatRunStateSchema>;

const CHAT_SYSTEM_PROMPT = [
  "You are Alfred, the user's personal assistant. You are chatting with them directly.",
  "Be warm, concise, and direct. Answer the question; don't pad.",
  "Use integration tools for the user's real email, calendar, documents, files, and connected services. Integration tools are named integration.action, for example calendar.list_events; never call a bare action name like list_events.",
  "When the user asks for a real connected service and its tool is not available yet, infer the needed integration and call system.load_integration yourself. Do not ask the user to load an integration just to proceed.",
  "For a demanding, multi-part request, use system.spawn_sub_agent to investigate in parallel, then synthesize.",
  "Write actions (sending email, creating events) are gated for user approval — propose them and the user will confirm.",
  "If a tool result says status is rejected_by_user, do not retry the identical proposal.",
  "Finish each turn with a clear reply and no trailing tool calls.",
].join("\n\n");

// ── helpers ─────────────────────────────────────────────────────────────────

function preview(value: unknown): string {
  let s: string;
  try {
    s = typeof value === "string" ? value : JSON.stringify(value);
  } catch {
    s = String(value);
  }
  s = s ?? "";
  // Reserve one char for the ellipsis: the `chat.tool` event schema caps both
  // previews at max(PREVIEW_CHARS), and `publishEvent` throws on overflow —
  // which would kill the whole turn on routine long tool output.
  return s.length > PREVIEW_CHARS ? `${s.slice(0, PREVIEW_CHARS - 1)}…` : s;
}

function resolveSdkTools(activeIntegrations: readonly string[]): ToolSet {
  const out: Partial<Record<ToolName, Tool>> = {};
  const slugs = [...new Set(["system", ...activeIntegrations])];
  for (const slug of slugs) {
    if (!isIntegrationSlug(slug)) continue;
    for (const registered of listToolsForIntegration(slug)) {
      out[registered.name] = tool({
        description: registered.description,
        inputSchema: registered.inputSchema,
      });
    }
  }
  return out as ToolSet;
}

function toolResultMessage(
  call: PendingToolCall,
  result: Exclude<DispatchResult, { kind: "staged" }>,
): AgentTranscriptMessage {
  return {
    role: "tool",
    content: [
      {
        type: "tool-result",
        toolCallId: call.toolCallId,
        toolName: call.toolName,
        output: dispatchResultToToolOutput(result),
      },
    ],
  };
}

function dispatchResultToToolOutput(
  result: Exclude<DispatchResult, { kind: "staged" }>,
): { type: "json"; value: unknown } | { type: "error-json"; value: unknown } {
  switch (result.kind) {
    case "executed":
      return {
        type: "json",
        value: toJsonValue({ status: "executed", result: result.toolResult }),
      };
    case "failed":
      return { type: "error-json", value: toJsonValue({ status: "failed", error: result.error }) };
    default:
      return { type: "json", value: toJsonValue(result.result) };
  }
}

function toJsonValue(value: unknown): unknown {
  if (value === undefined) return null;
  try {
    return JSON.parse(JSON.stringify(value)) as unknown;
  } catch {
    return { unserializable: String(value) };
  }
}

function applyLoadIntegrationEffect(
  state: ChatRunState,
  toolName: string,
  result: DispatchResult,
): void {
  if (toolName !== "system.load_integration" || result.kind !== "executed") return;
  const r = result.toolResult as { ok?: unknown; slug?: unknown };
  if (r?.ok === true && typeof r.slug === "string" && isIntegrationSlug(r.slug)) {
    state.activeIntegrations = [...new Set([...state.activeIntegrations, r.slug])];
  }
}

function splitEventText(text: string): string[] {
  const chunks: string[] = [];
  for (let i = 0; i < text.length; i += CHAT_DELTA_MAX) {
    chunks.push(text.slice(i, i + CHAT_DELTA_MAX));
  }
  return chunks;
}

// ── steps ─────────────────────────────────────────────────────────────────

const chatTurnStep: Step<ChatRunState> = {
  id: "chat-turn",
  async run(ctx) {
    const state: ChatRunState = { ...ctx.state, turnCount: ctx.state.turnCount + 1 };
    try {
      if (ctx.state.turnCount >= TURN_CAP_MAX) {
        throw new Error("chat_turn_limit_exceeded");
      }
      const transcript = [...ctx.transcript];

      if (!state.started) {
        state.started = true;
        await publishEvent({
          userId: ctx.userId,
          kind: "chat.message",
          payload: {
            runId: ctx.runId,
            threadId: state.threadId,
            messageId: state.messageId,
            phase: "started",
          },
        });
      }

      const agent = new AlfredAgent({
        id: "chat",
        system: CHAT_SYSTEM_PROMPT,
        tools: () => resolveSdkTools(state.activeIntegrations),
        model: getChatModel(state.tier),
        // Ask the model to expose its thinking so the turn streams
        // `reasoning-delta` parts → the chat UI's "Thinking…" accordion.
        providerOptions: getChatProviderOptions(),
        attribution: { kind: "llm", userId: ctx.userId, runId: ctx.runId },
      });

      const stream = await agent.streamTurn({
        ctx,
        transcript: transcript as ModelMessage[],
        attribution: { stepId: ctx.idempotencyKey, attempt: ctx.attempt, role: "boss" },
      });

      // Drain the live stream → coalesce text into `chat.delta`, reasoning into
      // `chat.reasoning`, and surface each tool call as a `chat.tool` started
      // card. Reasoning and reply text get independent buffers + seqs so the
      // client orders each track on its own.
      let buffer = "";
      let lastFlush = Date.now();
      const flush = async (): Promise<void> => {
        if (buffer.length === 0) return;
        const text = buffer;
        buffer = "";
        lastFlush = Date.now();
        for (const chunk of splitEventText(text)) {
          state.deltaSeq += 1;
          await publishEvent({
            userId: ctx.userId,
            kind: "chat.delta",
            payload: {
              runId: ctx.runId,
              threadId: state.threadId,
              messageId: state.messageId,
              seq: state.deltaSeq,
              text: chunk,
            },
          });
        }
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
          await publishEvent({
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

      for await (const part of stream.fullStream) {
        if (part.type === "text-delta") {
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
          await publishEvent({
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
            },
          });
        } else if (part.type === "error") {
          // A mid-stream error (provider fault, timeout abort) surfaces here;
          // throw so the catch below finalizes the turn as failed.
          throw part.error instanceof Error ? part.error : new Error(String(part.error));
        }
      }
      // Some providers end the stream without a `reasoning-end`; close the
      // duration and flush any trailing thinking before the reply flush.
      if (reasoningStart > 0) {
        state.reasoningMs += Date.now() - reasoningStart;
        reasoningStart = 0;
      }
      await flushReasoning();
      await flush();

      const [toolCalls, finishReason, response] = await Promise.all([
        stream.toolCalls,
        stream.finishReason,
        stream.response,
      ]);
      const nextTranscript = [...transcript, ...(response.messages as AgentTranscriptMessage[])];
      const outcome = classifyStreamFinish({ toolCalls, finishReason });

      if (outcome.kind === "tool-calls") {
        state.pendingToolCalls = toolCalls.map((call) => ({
          toolCallId: call.toolCallId,
          toolName: call.toolName,
          input: call.input,
        }));
        return { kind: "next", state, transcript: nextTranscript, nextStep: "dispatch-tools" };
      }

      if (state.assistantText.trim().length === 0) {
        // Terminal provider anomaly: no tool calls and no assistant text leaves
        // nothing useful to retry from this completed stream, so fail the run
        // once and persist a legible failed assistant message for the client.
        throw new Error("Assistant finished without producing a response.");
      }

      // final | stopped → persist the assistant message and complete.
      await finalizeAssistantMessage(ctx.userId, ctx.runId, state);
      return {
        kind: "done",
        state,
        transcript: nextTranscript,
        output: { messageId: state.messageId },
      };
    } catch (err) {
      // Any terminal failure (stream error, turn-cap, preview overflow, a down
      // provider) must still close the loop for the client: persist a failed
      // assistant row + emit `chat.message completed` so the streaming bubble
      // reconciles instead of blinking forever. Rethrow so the executor records
      // the run failure for audit.
      await finalizeFailedMessage(ctx.userId, ctx.runId, state, errorText(err));
      throw err;
    }
  },
};

const dispatchToolsStep: Step<ChatRunState> = {
  id: "dispatch-tools",
  async run(ctx) {
    const state: ChatRunState = {
      ...ctx.state,
      pendingToolCalls: [...ctx.state.pendingToolCalls],
      activeIntegrations: [...ctx.state.activeIntegrations],
      toolCallsLog: [...ctx.state.toolCallsLog],
    };
    let transcript = [...ctx.transcript];

    try {
      while (state.pendingToolCalls.length > 0) {
        const call = state.pendingToolCalls[0]!;
        const result = await dispatchToolCall({
          runId: ctx.runId,
          stepId: "dispatch-tools",
          toolCallId: call.toolCallId,
          toolName: call.toolName,
          input: call.input,
          userId: ctx.userId,
          caller: "boss",
          scratchpadRunId: ctx.runId,
          allowedIntegrations: state.allowedIntegrations,
        });

        if (result.kind === "staged") {
          // Write action awaiting approval — park the run. The HIL approval
          // card surfaces via `approval.requested`; resume re-enters this step.
          return { kind: "interrupt", state, transcript, wake: result.wake };
        }

        applyLoadIntegrationEffect(state, call.toolName, result);

        const status = result.kind === "executed" ? "succeeded" : "failed";
        const resultPreview =
          result.kind === "executed"
            ? preview(result.toolResult)
            : result.kind === "failed"
              ? preview(result.error)
              : preview(result.result);
        state.toolCallsLog.push({
          toolCallId: call.toolCallId,
          toolName: call.toolName,
          status,
          resultPreview,
        });
        await publishEvent({
          userId: ctx.userId,
          kind: "chat.tool",
          payload: {
            runId: ctx.runId,
            threadId: state.threadId,
            messageId: state.messageId,
            toolCallId: call.toolCallId,
            toolName: call.toolName,
            status,
            resultPreview,
          },
        });

        transcript = [...transcript, toolResultMessage(call, result)];
        state.pendingToolCalls = state.pendingToolCalls.slice(1);
      }

      return { kind: "next", state, transcript, nextStep: "chat-turn" };
    } catch (err) {
      // Mirror chatTurnStep: an unexpected fault during dispatch still closes
      // the loop for the client instead of stranding the streaming bubble.
      await finalizeFailedMessage(ctx.userId, ctx.runId, state, errorText(err));
      throw err;
    }
  },
};

/**
 * Persist the finished assistant turn and poke the client. The durable row is
 * what survives reload / reaches other devices; the streamed deltas were
 * ephemeral. Idempotent on messageId so a re-attempt after the executor
 * commits doesn't double-insert.
 */
async function finalizeAssistantMessage(
  userId: string,
  runId: string,
  state: ChatRunState,
): Promise<void> {
  const now = new Date();
  await db()
    .insert(chatMessages)
    .values({
      id: state.messageId,
      userId,
      threadId: state.threadId,
      role: "assistant",
      content: state.assistantText,
      reasoning: state.reasoningText.length > 0 ? state.reasoningText : null,
      reasoningMs: state.reasoningMs > 0 ? state.reasoningMs : null,
      status: "complete",
      toolCalls: state.toolCallsLog.length > 0 ? state.toolCallsLog : null,
      runId,
    })
    .onConflictDoUpdate({
      target: chatMessages.id,
      set: {
        content: state.assistantText,
        reasoning: state.reasoningText.length > 0 ? state.reasoningText : null,
        reasoningMs: state.reasoningMs > 0 ? state.reasoningMs : null,
        status: "complete",
        toolCalls: state.toolCallsLog.length > 0 ? state.toolCallsLog : null,
        runId,
        rowVersion: sql`${chatMessages.rowVersion} + 1`,
        updatedAt: now,
      },
      setWhere: and(
        eq(chatMessages.status, "failed"),
        eq(chatMessages.userId, userId),
        eq(chatMessages.threadId, state.threadId),
      ),
    });
  await db()
    .update(chatThreads)
    .set({ lastMessageAt: now, rowVersion: sql`${chatThreads.rowVersion} + 1` })
    .where(and(eq(chatThreads.id, state.threadId), eq(chatThreads.userId, userId)));

  await publishEvent({
    userId,
    kind: "chat.message",
    payload: { runId, threadId: state.threadId, messageId: state.messageId, phase: "completed" },
  });
  emitReplicachePokes([userId]);

  // Name the thread from its opening exchange. Runs after the message is
  // poked so the durable reply syncs first; the title lands a beat later as
  // its own poke. Best-effort — a failure leaves the placeholder title.
  await maybeGenerateThreadTitle({
    userId,
    runId,
    threadId: state.threadId,
    assistantMessageId: state.messageId,
    assistantText: state.assistantText,
  });
}

/**
 * Cosmetic cap on a generated thread title — matches the placeholder cap in
 * the chat turn endpoint so the sidebar row never has to ellipsize twice.
 */
const TITLE_MAX_CHARS = 60;

const TITLE_SYSTEM_PROMPT = [
  "You write very short titles for a chat conversation.",
  "Given the opening exchange, reply with a 2–6 word title naming the topic.",
  "Use Title Case. No surrounding quotes, no trailing punctuation, no emoji.",
  "Reply with the title only — nothing else.",
].join("\n");

/**
 * Derive a human title for the thread from its first exchange. Runs exactly
 * once — on the thread's first assistant reply — then leaves the title alone
 * on later turns. The turn endpoint already seeded a placeholder (the
 * truncated first message), so this is a refinement, not the only title the
 * user ever sees. Never throws into the turn: a title is cosmetic and a model
 * blip must not fail an otherwise-good reply.
 */
async function maybeGenerateThreadTitle(args: {
  userId: string;
  runId: string;
  threadId: string;
  assistantMessageId: string;
  assistantText: string;
}): Promise<void> {
  const { userId, runId, threadId, assistantMessageId, assistantText } = args;
  try {
    // Only the first reply names the thread. Any earlier assistant row means
    // the title was already derived on a prior turn — leave it.
    const priorReply = await db()
      .select({ id: chatMessages.id })
      .from(chatMessages)
      .where(
        and(
          eq(chatMessages.userId, userId),
          eq(chatMessages.threadId, threadId),
          eq(chatMessages.role, "assistant"),
          ne(chatMessages.id, assistantMessageId),
        ),
      )
      .limit(1);
    if (priorReply.length > 0) return;

    const firstUser = await db()
      .select({ content: chatMessages.content })
      .from(chatMessages)
      .where(
        and(
          eq(chatMessages.userId, userId),
          eq(chatMessages.threadId, threadId),
          eq(chatMessages.role, "user"),
        ),
      )
      .orderBy(asc(chatMessages.createdAt), asc(chatMessages.id))
      .limit(1);
    const userText = firstUser[0]?.content?.trim() ?? "";
    if (userText.length === 0) return;

    const result = await meteredGenerateText(
      {
        model: getCheapModel(),
        system: TITLE_SYSTEM_PROMPT,
        prompt: [
          `User: ${userText.slice(0, 1_000)}`,
          assistantText.trim().length > 0 ? `Alfred: ${assistantText.slice(0, 1_000)}` : null,
          "",
          "Title:",
        ]
          .filter((line): line is string => line !== null)
          .join("\n"),
        temperature: 0.3,
        maxOutputTokens: 32,
        timeout: TITLE_TIMEOUT_MS,
      },
      { kind: "llm", userId, runId, name: "chat.thread-title" },
    );

    const title = cleanTitle(result.text);
    if (!title) return;

    await db()
      .update(chatThreads)
      .set({ title, rowVersion: sql`${chatThreads.rowVersion} + 1` })
      .where(and(eq(chatThreads.id, threadId), eq(chatThreads.userId, userId)));
    emitReplicachePokes([userId]);
  } catch (err) {
    console.warn(`[chat-turn] thread title generation failed for ${threadId}:`, err);
  }
}

/**
 * Normalize a model-produced title: drop a leading "Title:" echo, strip
 * wrapping quotes, collapse whitespace, trim trailing punctuation, and cap
 * the length. Returns null when nothing usable remains.
 */
function cleanTitle(raw: string): string | null {
  let s = raw.trim();
  if (s.length === 0) return null;
  s = s.replace(/^title\s*[:\-—]\s*/i, "");
  s = s.replace(/^["'“”`]+|["'“”`]+$/g, "");
  s = s.replace(/\s+/g, " ").trim();
  s = s.replace(/[.。!?]+$/, "").trim();
  if (s.length === 0) return null;
  if (s.length > TITLE_MAX_CHARS) s = `${s.slice(0, TITLE_MAX_CHARS - 1).trimEnd()}…`;
  return s;
}

/**
 * Terminal-failure counterpart to {@link finalizeAssistantMessage}. Persists a
 * `status:"failed"` assistant row (carrying whatever text streamed before the
 * fault) and emits `chat.message completed` so the client's streaming bubble
 * reconciles to the durable row instead of blinking indefinitely. Idempotent
 * on messageId; the partial-failure `error` is surfaced via the failed status.
 */
async function finalizeFailedMessage(
  userId: string,
  runId: string,
  state: ChatRunState,
  error: string,
): Promise<void> {
  const now = new Date();
  const content =
    state.assistantText.length > 0
      ? state.assistantText
      : `Something went wrong on my end. (${error})`;
  await db()
    .insert(chatMessages)
    .values({
      id: state.messageId,
      userId,
      threadId: state.threadId,
      role: "assistant",
      content,
      reasoning: state.reasoningText.length > 0 ? state.reasoningText : null,
      reasoningMs: state.reasoningMs > 0 ? state.reasoningMs : null,
      status: "failed",
      toolCalls: state.toolCallsLog.length > 0 ? state.toolCallsLog : null,
      runId,
    })
    .onConflictDoNothing();
  await db()
    .update(chatThreads)
    .set({ lastMessageAt: now, rowVersion: sql`${chatThreads.rowVersion} + 1` })
    .where(and(eq(chatThreads.id, state.threadId), eq(chatThreads.userId, userId)));

  await publishEvent({
    userId,
    kind: "chat.message",
    payload: { runId, threadId: state.threadId, messageId: state.messageId, phase: "completed" },
  });
  emitReplicachePokes([userId]);
}

function errorText(err: unknown): string {
  const msg = err instanceof Error ? err.message : String(err);
  return msg.length > 500 ? `${msg.slice(0, 499)}…` : msg;
}

export const chatTurnWorkflow: Workflow<ChatRunState> = {
  slug: CHAT_TURN_WORKFLOW_SLUG,
  name: "Chat turn",
  trigger: { kind: "manual" },
  initialStep: "chat-turn",
  initialState(input) {
    const metadata = input.metadata ?? {};
    const threadId = typeof metadata.threadId === "string" ? metadata.threadId : null;
    if (!threadId) throw new Error("chat-turn workflow requires metadata.threadId");
    const messageId =
      typeof metadata.assistantMessageId === "string"
        ? metadata.assistantMessageId
        : `msg_${Math.abs(hashString(`${threadId}:${input.userId}:${metadata.kickId ?? ""}`))}`;
    const tier: ChatModelTier = metadata.tier === "deep" ? "deep" : "standard";
    const allowedIntegrations = Array.isArray(metadata.allowedIntegrations)
      ? metadata.allowedIntegrations.filter((v): v is string => typeof v === "string")
      : [];
    return {
      threadId,
      messageId,
      tier,
      activeIntegrations: [],
      allowedIntegrations,
      pendingToolCalls: [],
      assistantText: "",
      reasoningText: "",
      reasoningMs: 0,
      toolCallsLog: [],
      deltaSeq: 0,
      reasoningSeq: 0,
      turnCount: 0,
      started: false,
    };
  },
  async initialTranscript(input) {
    const metadata = input.metadata ?? {};
    const threadId = typeof metadata.threadId === "string" ? metadata.threadId : null;
    if (!threadId) throw new Error("chat-turn workflow requires metadata.threadId");
    const rows = await db()
      .select({ role: chatMessages.role, content: chatMessages.content })
      .from(chatMessages)
      .where(and(eq(chatMessages.userId, input.userId), eq(chatMessages.threadId, threadId)))
      .orderBy(asc(chatMessages.createdAt), asc(chatMessages.id));
    return rows
      .filter((r) => r.content.length > 0)
      .map((r) => ({ role: r.role, content: r.content }) satisfies AgentTranscriptMessage);
  },
  // Singleton on the client-minted user message id: a double-submit / retry /
  // strict-mode double-invoke of the same turn collides on the partial unique
  // index instead of spawning a second run (and a second streaming reply).
  // Failed/cancelled runs are excluded from the index, so a genuinely failed
  // turn stays retryable.
  dedupKey(input) {
    const id = input.metadata?.userMessageId;
    return typeof id === "string" && id.length > 0 ? `chat:${id}` : null;
  },
  steps: {
    "chat-turn": chatTurnStep,
    "dispatch-tools": dispatchToolsStep,
  },
  stateSchema: chatRunStateSchema,
};

/** Deterministic 31-bit hash for a fallback assistant message id. */
function hashString(s: string): number {
  let h = 0;
  for (let i = 0; i < s.length; i++) {
    h = (Math.imul(31, h) + s.charCodeAt(i)) | 0;
  }
  return h;
}
