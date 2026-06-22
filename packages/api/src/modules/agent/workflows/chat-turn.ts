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
import {
  chatModelTierSchema,
  isIntegrationSlug,
  isPassThrough,
  isRecord,
  toJsonValue,
  type AgentTranscriptMessage,
  type ToolName,
  toMessage,
} from "@alfred/contracts";
import { db } from "@alfred/db";
import { chatAttachments, chatMessages, chatThreads } from "@alfred/db/schemas";
import { CHAT_DELTA_MAX } from "@alfred/schemas/events";
import { and, asc, eq, inArray, ne, sql } from "drizzle-orm";
import { z } from "zod";
import { readObject } from "../../chat/storage";
import { isChatStopRequested } from "../../chat/stop-signal";
import { dispatchToolCall, toolCallWouldGate, type DispatchResult } from "../../dispatch";
import { emitReplicachePokes } from "../../../events/replicache-events";
import { publishEvent } from "../../../events/publish";
import { listToolsForIntegration } from "../../tools/registry";
import { buildConnectedSummary } from "../connected-summary";
import { formatDateGrounding, resolveUserTimezone } from "../grounding";
import type { Step, Workflow } from "../types";

/**
 * Interactive streaming chat (streaming-chat plan). One run services one user
 * turn end-to-end: the agent streams its reply (token deltas + tool-call
 * cards over the SSE event bus), tools dispatch (writes gate through the
 * existing HIL/approval interrupt), and the finished assistant message is
 * persisted to `chat_messages` so it survives reload and reaches every device.
 *
 * Models: `standard` (Sonnet 4.6) by default; `deep` (Opus 4.8) escalation is
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
/** Poll the user-stop flag at most this often while draining the stream (ms). */
const STOP_CHECK_MS = 400;
const PREVIEW_CHARS = 2_000;
/**
 * Pruning tiers tried loosest-first when a structured preview overflows
 * `PREVIEW_CHARS`: `[maxArrayItems, maxStringLen, maxObjectKeys]`. The first
 * tier whose serialization fits is used, so previews shrink only as much as
 * the cap demands. The tightest tier exists so even a pathologically wide
 * result still lands under the cap as valid JSON.
 */
const PREVIEW_TIERS: ReadonlyArray<readonly [number, number, number]> = [
  [5, 300, 64],
  [3, 160, 48],
  [2, 80, 32],
  [1, 40, 16],
];
const TITLE_TIMEOUT_MS = 15_000;

const pendingToolCallSchema = z.object({
  toolCallId: z.string().min(1),
  toolName: z.string().min(1),
  input: z.unknown(),
  /** Narration segment this call follows (see `chatRunStateSchema.segmentIndex`). */
  segmentIndex: z.number().int().nonnegative().default(0),
});
type PendingToolCall = z.infer<typeof pendingToolCallSchema>;

const toolCallLogSchema = z.object({
  toolCallId: z.string(),
  toolName: z.string(),
  status: z.enum(["succeeded", "failed"]),
  argsPreview: z.string().optional(),
  resultPreview: z.string().optional(),
  segmentIndex: z.number().int().nonnegative().default(0),
});

const narrationSegmentSchema = z.object({
  index: z.number().int().nonnegative(),
  text: z.string(),
});

const chatRunStateSchema = z.object({
  threadId: z.string().min(1),
  messageId: z.string().min(1),
  tier: chatModelTierSchema,
  activeIntegrations: z.array(z.string().min(1)),
  allowedIntegrations: z.array(z.string()),
  // ADR-0053 connected summary, snapshotted once at run start (first turn) and
  // reused every turn so the system-prompt prefix stays cache-stable.
  connectedSummary: z.string().optional(),
  // User's IANA timezone, snapshotted once on the first turn — it can't change
  // mid-run, so re-reading it from the DB every turn (like `connectedSummary`)
  // is wasted latency.
  timezone: z.string().optional(),
  pendingToolCalls: z.array(pendingToolCallSchema),
  // Text of the current (latest) narration segment. Accumulates within a step;
  // when a step ends with tool calls it's pushed onto `narration` and reset,
  // so by turn's end this holds only the final answer (what `content` persists).
  assistantText: z.string().default(""),
  // Closed narration segments — the brief lines written before each tool step.
  narration: z.array(narrationSegmentSchema).default([]),
  // Index of the current segment; bumped each time a tool-bearing step closes.
  segmentIndex: z.number().int().min(0).default(0),
  reasoningText: z.string().default(""),
  reasoningMs: z.number().int().min(0).default(0),
  toolCallsLog: z.array(toolCallLogSchema).default([]),
  deltaSeq: z.number().int().min(0).default(0),
  reasoningSeq: z.number().int().min(0).default(0),
  turnCount: z.number().int().min(0).default(0),
  started: z.boolean().default(false),
});
type ChatRunState = z.infer<typeof chatRunStateSchema>;

// Structured after the Anthropic prompt template: role first, the operating
// rules in a labelled block, then a couple of log-sourced boundary exemplars
// (the failure modes we actually observed — date-bouncing and tool-name
// invention; see boss-grounding-gaps notes). `buildChatSystemPrompt` appends
// the date and the ADR-0053 connected catalog last, so the strongest
// tool-grounding anchor still sits at the end of the prompt.
const CHAT_SYSTEM_PROMPT_BASE = [
  "You are Alfred, the user's personal assistant. You are chatting with them directly. Be warm, concise, and direct — answer the question and don't pad.",
  [
    "How you work:",
    "- Use integration tools for the user's real email, calendar, documents, files, and connected services. Integration tools are named integration.action (for example calendar.list_events); never call a bare action name like list_events.",
    "- Use only tools that exist. Never invent a plausible-sounding tool name — pick the closest real tool over guessing, and never ask the user for a parameter (a repo, an account, a date) you can resolve or look up yourself.",
    "- When the user asks for a real connected service whose tool is not active yet, infer the integration and call system.load_integration yourself. Do not ask the user to load an integration just to proceed.",
    '- Resolve relative or partial dates yourself from today\'s date (stated below) — "this week", "in October", "October 2026", "next Tuesday" — and never ask the user to clarify a date you can work out. For a calendar range the relative window fields (today, tomorrow, next_7_days) don\'t cover, call calendar.list_events with explicit RFC3339 timeMin/timeMax bounds.',
    "- Use system.read_user_context before answering questions or making judgments about the user's people, relationships, preferences, standing instructions, projects, or personal context. Do not guess from generic memory when this tool can read Alfred's stored context.",
    "- For a demanding, multi-part request, use system.spawn_sub_agent to investigate in parallel, then synthesize.",
    "- When the user asks Alfred to track something they need to do, use system.suggest_todo with a concise imperative title and any source ids you know. This creates a rail todo suggestion; it does not execute the task.",
    "- When the user asks to stop surfacing reminders, todos, or briefing items from a sender, use system.remember after resolving a concrete sender email. If the tool asks for clarification, ask the user rather than claiming it is done. When system.remember succeeds, say Alfred will stop surfacing reminders and briefing items from that sender, and that emails will still arrive in Gmail unless the user wants a Gmail filter.",
    "- When the user asks to dismiss or clear existing todos from a Gmail sender/thread, use system.resolve_todo after resolving the sender email or thread id.",
    "- Write actions (sending email, creating events) are gated for user approval — propose them and the user confirms. If a tool result says status is rejected_by_user, do not retry the identical proposal.",
    '- Before a step where you call tools, write one short present-tense line saying what you\'re about to do ("Checking your calendar.", "Drafting the reply."). Keep it to a single sentence — it appears in the activity trail beside the tools, not in your final reply.',
    '- Don\'t over-narrate: one brief line per tool step is plenty. Never apologize for or explain internal retries ("my mistake, I need to connect first") or thank the user for their patience.',
    "- Put your actual answer in your final message, written once the tools have returned. Keep it clean — don't repeat the narration lines there.",
  ].join("\n"),
  [
    "Examples of the judgment above:",
    '- User: "how many meetings do i have in october 2026" → call calendar.list_events with timeMin/timeMax bounding October 2026. Do NOT reply "which year?": the year is given, and today\'s date is below.',
    '- User: "what are my open PRs" → call the github tool that actually exists (for example github.search_pull_requests filtered to the user). Do NOT call an invented tool like github.list_pull_requests, and do NOT ask which repo — search across the user\'s PRs.',
  ].join("\n"),
  "Finish each turn with a clear reply and no trailing tool calls.",
].join("\n\n");

export function buildChatSystemPrompt(grounding: string, connectedSummary: string): string {
  return `${CHAT_SYSTEM_PROMPT_BASE}\n\nThe current date is ${grounding}.\n\n${connectedSummary}`;
}

// ── helpers ─────────────────────────────────────────────────────────────────

/**
 * Shrink a structured value by *pruning* — cap array lengths, truncate long
 * leaf strings, cap object key counts — rather than slicing the serialized
 * JSON. Slicing yields unparseable JSON, which silently breaks every client
 * that reads `resultPreview` back (follow-up chips, the tool-card detail pane).
 * Pruning preserves shape and validity: arrays keep their first few rows (so
 * `.length > 0` and sibling count fields like `totalCount` still read true),
 * just smaller.
 */
function pruneForPreview(
  value: unknown,
  maxArray: number,
  maxString: number,
  maxKeys: number,
): unknown {
  if (typeof value === "string") {
    return value.length > maxString ? `${value.slice(0, maxString - 1)}…` : value;
  }
  if (Array.isArray(value)) {
    return value.slice(0, maxArray).map((v) => pruneForPreview(v, maxArray, maxString, maxKeys));
  }
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value).slice(0, maxKeys)) {
      out[k] = pruneForPreview(v, maxArray, maxString, maxKeys);
    }
    return out;
  }
  return value;
}

function preview(value: unknown): string {
  // Strings are plain text (error messages, model output) — slice directly.
  if (typeof value === "string") {
    return value.length > PREVIEW_CHARS ? `${value.slice(0, PREVIEW_CHARS - 1)}…` : value;
  }
  let full: string;
  try {
    full = JSON.stringify(value) ?? "";
  } catch {
    full = String(value);
  }
  if (full.length <= PREVIEW_CHARS) return full;

  // Over budget: prune the structure, tightening tier by tier, so the preview
  // stays *valid JSON* under the cap. The `chat.tool` event schema caps
  // previews at PREVIEW_CHARS and `publishEvent` throws on overflow, so we must
  // land under it.
  try {
    for (const [maxArray, maxString, maxKeys] of PREVIEW_TIERS) {
      const pruned = JSON.stringify(pruneForPreview(value, maxArray, maxString, maxKeys)) ?? "";
      if (pruned && pruned.length <= PREVIEW_CHARS) return pruned;
    }
  } catch {
    // fall through to the slice below
  }
  // Even the tightest tier overflowed (or pruning threw) — last resort is a
  // slice, accepting that this rare preview won't parse. Reserve a char for the
  // ellipsis.
  return `${full.slice(0, PREVIEW_CHARS - 1)}…`;
}

// The SDK calls `tools: () => resolveSdkTools(...)` once per turn, but the
// registry is static, so the object graph only changes when the active slug set
// does. Memoize per normalized slug key (the loadable integration set is small
// and bounded, so the unevicted cache stays tiny). The returned `ToolSet` is
// treated as read-only by the SDK, so sharing one instance across turns/users
// is safe.
const sdkToolsCache = new Map<string, ToolSet>();

function resolveSdkTools(activeIntegrations: readonly string[]): ToolSet {
  const slugs = [...new Set(["system", ...activeIntegrations])].sort();
  const key = slugs.join(",");
  const cached = sdkToolsCache.get(key);
  if (cached) return cached;

  const out: Partial<Record<ToolName, Tool>> = {};
  for (const slug of slugs) {
    if (!isIntegrationSlug(slug)) continue;
    for (const registered of listToolsForIntegration(slug)) {
      out[registered.name] = tool({
        description: registered.description,
        inputSchema: registered.inputSchema,
      });
    }
  }
  const tools = out as ToolSet;
  sdkToolsCache.set(key, tools);
  return tools;
}

/** A `ready` attachment as the transcript builder needs it. */
interface ReadyAttachment {
  storageKey: string;
  mime: string;
  degradedText: string | null;
  degradedImageKeys: string[];
}

const CHAT_ATTACHMENT_IMAGE_PART = "chat_attachment_image";

interface StoredChatAttachmentImagePart {
  type: typeof CHAT_ATTACHMENT_IMAGE_PART;
  storageKey: string;
  mediaType?: string;
}

type StoredChatContentPart = { type: "text"; text: string } | StoredChatAttachmentImagePart;

function storedAttachmentImagePart(
  storageKey: string,
  mediaType?: string,
): StoredChatAttachmentImagePart {
  return mediaType
    ? { type: CHAT_ATTACHMENT_IMAGE_PART, storageKey, mediaType }
    : { type: CHAT_ATTACHMENT_IMAGE_PART, storageKey };
}

function isStoredAttachmentImagePart(value: unknown): value is StoredChatAttachmentImagePart {
  return (
    isRecord(value) &&
    value.type === CHAT_ATTACHMENT_IMAGE_PART &&
    typeof value.storageKey === "string" &&
    (value.mediaType === undefined || typeof value.mediaType === "string")
  );
}

/**
 * Load the `ready` attachments for a set of messages, grouped by message id.
 * Only `ready` rows are folded into the model context — `pending` (still
 * degrading) and `failed` rows are skipped, so a slow degrade can't block the
 * turn (ADR-0065's bounded-await / graceful-partial posture).
 */
async function loadReadyAttachments(
  userId: string,
  messageIds: string[],
): Promise<Map<string, ReadyAttachment[]>> {
  const byMessage = new Map<string, ReadyAttachment[]>();
  if (messageIds.length === 0) return byMessage;
  const rows = await db()
    .select({
      messageId: chatAttachments.messageId,
      storageKey: chatAttachments.storageKey,
      mime: chatAttachments.mime,
      degradedText: chatAttachments.degradedText,
      degradedImageKeys: chatAttachments.degradedImageKeys,
    })
    .from(chatAttachments)
    .where(
      and(
        eq(chatAttachments.userId, userId),
        inArray(chatAttachments.messageId, messageIds),
        eq(chatAttachments.status, "ready"),
      ),
    )
    .orderBy(
      asc(chatAttachments.position),
      asc(chatAttachments.createdAt),
      asc(chatAttachments.id),
    );
  for (const r of rows) {
    const list = byMessage.get(r.messageId) ?? [];
    list.push({
      storageKey: r.storageKey,
      mime: r.mime,
      degradedText: r.degradedText,
      degradedImageKeys: r.degradedImageKeys,
    });
    byMessage.set(r.messageId, list);
  }
  return byMessage;
}

/**
 * Build an AI-SDK content-parts array for a user message that has attachments:
 * the typed text first, then each attachment's contribution. The durable
 * transcript stores object keys, not bytes; `hydrateTranscriptForModel` reads
 * each object's bytes back and inlines them immediately before each model call.
 * A degraded modality (Phase 2/3) contributes its extracted `degradedText` plus
 * any keyframe images.
 */
function buildStoredContentParts(
  text: string,
  attachments: ReadyAttachment[],
): StoredChatContentPart[] {
  const parts: StoredChatContentPart[] = [];
  if (text.length > 0) parts.push({ type: "text", text });
  for (const a of attachments) {
    if (isPassThrough(a.mime)) {
      parts.push(storedAttachmentImagePart(a.storageKey, a.mime));
      continue;
    }
    if (a.degradedText && a.degradedText.length > 0) {
      parts.push({ type: "text", text: a.degradedText });
    }
    for (const key of a.degradedImageKeys) {
      parts.push(storedAttachmentImagePart(key));
    }
  }
  return parts;
}

async function hydrateContentForModel(content: unknown): Promise<unknown> {
  if (!Array.isArray(content)) return content;
  const parts: unknown[] = [];
  for (const part of content) {
    if (!isStoredAttachmentImagePart(part)) {
      parts.push(part);
      continue;
    }
    // Inline the raw bytes (ADR-0065 "bytes path") instead of a presigned URL:
    // the providers can't fetch our private, short-lived Railway storage URLs,
    // so a URL-valued image part fails the turn (boss + fallback alike).
    const image = await readObject(part.storageKey);
    parts.push(
      part.mediaType
        ? { type: "image", image, mediaType: part.mediaType }
        : { type: "image", image },
    );
  }
  return parts;
}

async function hydrateTranscriptForModel(
  transcript: readonly AgentTranscriptMessage[],
): Promise<AgentTranscriptMessage[]> {
  const out: AgentTranscriptMessage[] = [];
  for (const message of transcript) {
    out.push({ ...message, content: await hydrateContentForModel(message.content) });
  }
  return out;
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

/**
 * All of this turn's assistant prose in order: the closed narration segments
 * followed by the current segment. Used where the transcript needs the full
 * thing (e.g. a stopped turn); the persisted `content` keeps only the final
 * segment so the durable reply stays free of narration lead-ins.
 */
function fullAssistantText(state: ChatRunState): string {
  return [...state.narration.map((n) => n.text), state.assistantText]
    .filter((t) => t.trim().length > 0)
    .join("\n\n");
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
      const modelTranscript = await hydrateTranscriptForModel(transcript);

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

      if (state.timezone === undefined) {
        state.timezone = await resolveUserTimezone(ctx.userId);
      }
      if (state.connectedSummary === undefined) {
        state.connectedSummary = await buildConnectedSummary(ctx.userId, state.allowedIntegrations);
      }
      const agent = new AlfredAgent({
        id: "chat",
        system: buildChatSystemPrompt(formatDateGrounding(state.timezone), state.connectedSummary),
        tools: () => resolveSdkTools(state.activeIntegrations),
        model: getChatModel(state.tier),
        // Ask the model to expose its thinking so the turn streams
        // `reasoning-delta` parts → the chat UI's "Thinking…" accordion.
        // Tier-aware: `deep` escalates Anthropic adaptive-thinking effort.
        providerOptions: getChatProviderOptions(state.tier),
        attribution: { kind: "llm", userId: ctx.userId, runId: ctx.runId },
      });

      // User-initiated stop (composer stop button → Redis flag). Polled while
      // draining the stream; on stop we abort the provider call, keep whatever
      // streamed, and finalize through the normal completion path.
      const stopController = new AbortController();
      let stopRequested = false;
      let lastStopCheck = Date.now();
      const checkStop = async (): Promise<boolean> => {
        if (stopRequested) return true;
        if (Date.now() - lastStopCheck < STOP_CHECK_MS) return false;
        lastStopCheck = Date.now();
        if (await isChatStopRequested(ctx.runId)) {
          stopRequested = true;
          stopController.abort();
        }
        return stopRequested;
      };

      const stream = await agent.streamTurn({
        ctx,
        transcript: modelTranscript as ModelMessage[],
        attribution: { stepId: ctx.idempotencyKey, attempt: ctx.attempt, role: "boss" },
        abortSignal: stopController.signal,
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
              segmentIndex: state.segmentIndex,
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

      try {
        for await (const part of stream.fullStream) {
          if (await checkStop()) break;
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
                segmentIndex: state.segmentIndex,
              },
            });
          } else if (part.type === "error") {
            // A mid-stream error (provider fault, timeout abort) surfaces here;
            // throw so the catch below finalizes the turn as failed. Our own
            // stop-abort can land here too on some providers — not a fault.
            if (stopRequested) break;
            throw part.error instanceof Error ? part.error : new Error(String(part.error));
          }
        }
      } catch (err) {
        // The stop-abort can also surface as a thrown AbortError from the
        // stream iterator itself; swallow it only when we asked for it.
        if (!stopRequested) throw err;
      }
      // Some providers end the stream without a `reasoning-end`; close the
      // duration and flush any trailing thinking before the reply flush.
      if (reasoningStart > 0) {
        state.reasoningMs += Date.now() - reasoningStart;
        reasoningStart = 0;
      }
      await flushReasoning();
      await flush();

      if (stopRequested) {
        // User hit stop: persist whatever streamed and complete the run.
        // Skip `stream.toolCalls/finishReason/response` — after an abort those
        // promises may never settle. An empty partial persists as an empty
        // assistant row (renders as nothing), which is honest: the user
        // stopped before the model said anything.
        await finalizeAssistantMessage(ctx.userId, ctx.runId, state);
        // The transcript's assistant turn should reflect everything the model
        // said this turn — earlier narration segments plus the current one.
        const stoppedText = fullAssistantText(state);
        const stoppedTranscript =
          stoppedText.length > 0
            ? [
                ...transcript,
                {
                  role: "assistant",
                  content: stoppedText,
                } satisfies AgentTranscriptMessage,
              ]
            : transcript;
        return {
          kind: "done",
          state,
          transcript: stoppedTranscript,
          output: { messageId: state.messageId, stopped: true },
        };
      }

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
          segmentIndex: state.segmentIndex,
        }));
        // Close the current narration segment: the text the model wrote this
        // step was a lead-in to these tools, not the answer. Stash it (if any)
        // and advance so the next step's text — and the eventual answer — lands
        // in a fresh segment. `assistantText` thus always holds just the latest
        // segment, which at turn's end is the final reply.
        if (state.assistantText.trim().length > 0) {
          state.narration = [
            ...state.narration,
            { index: state.segmentIndex, text: state.assistantText },
          ];
        }
        state.assistantText = "";
        state.segmentIndex += 1;
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
      const calls = state.pendingToolCalls;
      if (calls.length > 0) {
        // User hit stop before the batch went out: drop the pending calls and
        // finalize with whatever streamed so far. Checked once up front — the
        // batch dispatches concurrently below, so there's no mid-loop point to
        // bail at (and a per-call check would race the in-flight dispatches).
        if (await isChatStopRequested(ctx.runId)) {
          await finalizeAssistantMessage(ctx.userId, ctx.runId, state);
          return {
            kind: "done",
            state,
            transcript,
            output: { messageId: state.messageId, stopped: true },
          };
        }

        // Dispatch the batch with HIL-safe parallelism. Autonomy calls (reads,
        // `system.*`) execute concurrently — that's the latency win, Σ(tool) →
        // max(tool). Gated writes only *stage* during dispatch (a fast local
        // insert; the real work runs after approval), so they gain nothing from
        // parallelism, and staging several at once is wrong: the run parks on a
        // single `approvalId`, so any approval card past the first would 409 on
        // `wake_mismatch`, and each gated row fires its own approval email. So
        // we dispatch gated calls *serially* in transcript order and stop at the
        // first that stages — surfacing exactly one approval per resume.
        // `toolCallWouldGate` is the scheduling hint; `dispatchToolCall` stays
        // the source of truth (it honors the row's stored `requires_approval`).
        // `dispatchToolCall` is idempotent on `(runId, toolCallId)` — see the
        // `executed` short-circuit in `dispatch/index.ts` — so on resume the
        // whole batch re-dispatches harmlessly and only the now-approved write
        // actually runs.
        const gateFlags = await Promise.all(
          calls.map((call) => toolCallWouldGate(ctx.userId, call.toolName)),
        );
        const dispatch = (call: PendingToolCall) =>
          dispatchToolCall({
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

        const results: (DispatchResult | undefined)[] = Array.from({ length: calls.length });
        // Autonomy bucket — concurrent.
        await Promise.all(
          calls.map(async (call, i) => {
            if (gateFlags[i]) return;
            results[i] = await dispatch(call);
          }),
        );
        // Gated bucket — serial in transcript order, stop at the first that
        // stages. Earlier gated calls that resolved on a prior approval execute
        // here (idempotent); later ones stay undispatched and stage on the next
        // resume, so only one approval surfaces at a time.
        for (let i = 0; i < calls.length; i++) {
          if (!gateFlags[i]) continue;
          const result = await dispatch(calls[i]!);
          results[i] = result;
          if (result.kind === "staged") break;
        }

        // A gated write parks the run. Return the interrupt for the
        // first-staged call (in transcript order) WITHOUT committing any
        // sibling result: leave `pendingToolCalls` and `transcript` untouched
        // so that on resume the entire batch re-dispatches — the already-
        // executed siblings short-circuit on `(runId, toolCallId)` idempotency
        // and the now-approved write runs. The transcript is then assembled in
        // a single ordered pass once nothing stages.
        const stagedResult = results.find(
          (r): r is Extract<DispatchResult, { kind: "staged" }> => r?.kind === "staged",
        );
        if (stagedResult) {
          return { kind: "interrupt", state, transcript, wake: stagedResult.wake };
        }

        // No gate in the batch — commit every result in original call order
        // (transcript order is load-bearing). With nothing staged, every call
        // was dispatched, so each slot is populated.
        for (let i = 0; i < calls.length; i++) {
          const call = calls[i]!;
          const result = results[i]!;
          // Already handled above; the guard also narrows `result` away from
          // `staged` for the helpers below.
          if (result.kind === "staged") continue;

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
            segmentIndex: call.segmentIndex,
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
              segmentIndex: call.segmentIndex,
            },
          });

          transcript = [...transcript, toolResultMessage(call, result)];
        }
        state.pendingToolCalls = [];
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
      narration: state.narration.length > 0 ? state.narration : null,
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
        narration: state.narration.length > 0 ? state.narration : null,
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

  // Name the thread from its opening exchange. Fire-and-forget: this does two
  // SELECTs plus a cheap-model call (up to TITLE_TIMEOUT_MS), and awaiting it
  // would keep the run `running` — holding the worker/lease past the
  // user-visible completion and serializing the next chat turn behind it. The
  // title is purely cosmetic, already best-effort, and idempotent (only the
  // first reply names the thread), so it lands a beat later as its own
  // Replicache poke without blocking the turn. `maybeGenerateThreadTitle` never
  // rejects (it swallows all errors), so the floating promise can't surface an
  // unhandled rejection.
  void maybeGenerateThreadTitle({
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
      narration: state.narration.length > 0 ? state.narration : null,
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
  const msg = toMessage(err);
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
      narration: [],
      segmentIndex: 0,
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
      .select({ id: chatMessages.id, role: chatMessages.role, content: chatMessages.content })
      .from(chatMessages)
      .where(and(eq(chatMessages.userId, input.userId), eq(chatMessages.threadId, threadId)))
      .orderBy(asc(chatMessages.createdAt), asc(chatMessages.id));

    // Fold in any uploaded attachments (ADR-0065). Only `ready` rows enter the
    // model context, and only as text + images — the raw bytes are never sent.
    // Phase 1 carries images straight through (object bytes → image part);
    // degraded modalities (Phase 2/3) contribute their `degradedText` +
    // keyframe images instead.
    const attachmentsByMessage = await loadReadyAttachments(
      input.userId,
      rows.map((r) => r.id),
    );

    const out: AgentTranscriptMessage[] = [];
    for (const r of rows) {
      const atts = attachmentsByMessage.get(r.id) ?? [];
      // Drop only truly-empty turns (no text and nothing readable attached).
      if (r.content.length === 0 && atts.length === 0) continue;
      const content = atts.length > 0 ? buildStoredContentParts(r.content, atts) : r.content;
      out.push({ role: r.role, content } satisfies AgentTranscriptMessage);
    }
    return out;
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
