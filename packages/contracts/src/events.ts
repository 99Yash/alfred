import { z } from "zod";
import { approvalKindSchema } from "./agent";
import { chatConnectNudgeSchema } from "./chat";
import { sanitizeErrorMessage } from "./sanitize";

export const CHAT_DELTA_MAX = 16_000;

/**
 * Caps on a `chat.tool` event's tool identity. Publishers must clamp: a model can invent any name,
 * and a payload the schema rejects makes `publishEvent` fail the whole run (ADR-0070).
 */
export const CHAT_TOOL_NAME_MAX = 120;

export const CHAT_TOOL_CALL_ID_MAX = 200;

/** Cap on an `agent.progress` frame's `message`. `StepContext.log` applies it. */
export const AGENT_PROGRESS_MESSAGE_MAX = 2_000;

/** Payloads for the outbox -> Redis Pub/Sub -> SSE bus. Replicache pokes use a separate bus. */
export const agentProgressSchema = z.object({
  runId: z.string().min(1).max(120),
  step: z.string().min(1).max(120),
  message: z.string().max(AGENT_PROGRESS_MESSAGE_MAX).optional(),
});

export const toolCallSchema = z.object({
  runId: z.string().min(1).max(120),
  toolName: z.string().min(1).max(120),
  status: z.enum(["started", "succeeded", "failed"]),
  detail: z.string().max(2_000).optional(),
});

export const approvalRequestedSchema = z.object({
  runId: z.string().min(1).max(120),
  approvalId: z.string().min(1).max(120),
  approvalKind: approvalKindSchema,
  prompt: z.string().min(1).max(4_000),
});

/**
 * Cap on an `agent.run` frame's `error`. `publishEvent` throws on an oversized payload,
 * and inside a commit hook that rolls back the terminal `failed` write.
 */
export const AGENT_RUN_ERROR_MAX = 4_000;

/** Branded so a raw `string` cannot reach the frame. Mint it with {@link boundAgentRunError}. */
export const agentRunErrorSchema = z.string().max(AGENT_RUN_ERROR_MAX).brand<"AgentRunError">();

export type AgentRunError = z.infer<typeof agentRunErrorSchema>;

/** The only way to mint an {@link AgentRunError}: strip ADR-0070 poison and apply the cap. */
export function boundAgentRunError(raw: string): AgentRunError {
  // SAFETY: sanitizeErrorMessage strips ADR-0070 poison and applies the cap, which is the brand.
  return sanitizeErrorMessage(raw, AGENT_RUN_ERROR_MAX) as AgentRunError;
}

export const agentRunSchema = z.object({
  runId: z.string().min(1).max(120),
  phase: z.enum([
    "started",
    "step_started",
    "step_completed",
    "interrupted",
    "resumed",
    "completed",
    "failed",
    "cancelled",
    "deferred",
    "blocked",
  ]),
  step: z.string().min(1).max(120).optional(),
  attempt: z.number().int().nonnegative().optional(),
  workflowSlug: z.string().min(1).max(120).optional(),
  wake: z.unknown().optional(),
  error: agentRunErrorSchema.optional(),
  retryAt: z.string().optional(),
});

export const memoryFactLearnedSchema = z.object({
  factId: z.string().min(1).max(120),
  key: z.string().min(1).max(200),
  preview: z.string().max(280),
  confidence: z.number().min(0).max(1),
});

/**
 * The inbox view needs a re-fetch: new documents (`ingested`) or a new triage category (`triaged`).
 * Publish at most once per ingest job or triage run. The payload stays minimal on purpose.
 */
export const inboxUpdatedSchema = z.object({
  reason: z.enum(["ingested", "triaged"]),
  /** Best-effort count for telemetry. */
  count: z.number().int().nonnegative().max(10_000).optional(),
});

/**
 * A coalesced chunk of chat text, not one token, so each token is not an outbox row.
 * `seq` is one counter for the whole run, carried across steps. It orders and dedupes the frames
 * of one attempt. A higher attempt cuts every frame above its `fromSeq` (`applyChatDelta`).
 * Ephemeral: the persisted message is the truth.
 */
export const chatDeltaSchema = z.object({
  runId: z.string().min(1).max(120),
  threadId: z.string().min(1).max(120),
  messageId: z.string().min(1).max(120),
  seq: z.number().int().nonnegative(),
  /** The run's step attempt that streamed it. 0 on rows written before the field existed. */
  attempt: z.number().int().nonnegative().default(0),
  /** The committed `seq` this attempt started after. Cut point when a higher attempt arrives. */
  fromSeq: z.number().int().nonnegative().default(0),
  text: z.string().max(CHAT_DELTA_MAX),
  /**
   * Tool calls split a turn's text into segments. Segment N is the narration before tool step N;
   * the highest segment is the answer. 0 for a turn with no tools.
   */
  segmentIndex: z.number().int().nonnegative().default(0),
});

/** Coalesced thinking text, like `chat.delta` but with its own `seq`. */
export const chatReasoningSchema = z.object({
  runId: z.string().min(1).max(120),
  threadId: z.string().min(1).max(120),
  messageId: z.string().min(1).max(120),
  seq: z.number().int().nonnegative(),
  /** The run's step attempt that streamed it. 0 on rows written before the field existed. */
  attempt: z.number().int().nonnegative().default(0),
  /** The committed reasoning `seq` this attempt started after. */
  fromSeq: z.number().int().nonnegative().default(0),
  text: z.string().max(CHAT_DELTA_MAX),
});

/**
 * Set on `chat.tool` events from a sub-agent (ADR-0016/0073).
 * The event keeps the parent's `runId`: the client keys a turn on (messageId, runId),
 * so the child's own runId would look like a new turn and reset the bubble.
 */
export const chatToolSubAgentSchema = z.object({
  /** The parent's `system.spawn_sub_agent` call this nests under. */
  parentToolCallId: z.string().min(1).max(200),
  /** The sub-agent id within the parent turn (`sub_a`). */
  subId: z.string().min(1).max(64),
  /** The child `agent_runs` row, to match its `agent.run` frames. */
  childRunId: z.string().min(1).max(120),
});

/**
 * A tool call in a chat turn, shown as a live card.
 * Write actions that need approval interrupt the run and emit `approval.requested` instead.
 */
export const chatToolSchema = z.object({
  runId: z.string().min(1).max(120),
  threadId: z.string().min(1).max(120),
  messageId: z.string().min(1).max(120),
  toolCallId: z.string().min(1).max(CHAT_TOOL_CALL_ID_MAX),
  toolName: z.string().min(1).max(CHAT_TOOL_NAME_MAX),
  status: z.enum(["started", "succeeded", "failed"]),
  /** Trimmed JSON preview of the tool input. */
  argsPreview: z.string().max(2_000).optional(),
  /** Trimmed preview of the tool result. */
  resultPreview: z.string().max(2_000).optional(),
  /** `preview()` pruned `resultPreview` to fit. It still parses, so only this flag tells. */
  resultTruncated: z.boolean().optional(),
  /** The ADR-0070 sanitizer stripped U+0000 or lone surrogates; the preview may be incomplete. */
  sanitized: z.boolean().optional(),
  /** The dispatcher rejected this call before it ran. The client retracts the `started` card. */
  nonExecution: z.boolean().optional(),
  /**
   * Set with `nonExecution` when the bounce was connection health, so chat can offer a nudge.
   * `.catch` keeps the frame when this bundle does not know the slug: only the nudge drops,
   * and the retraction still lands.
   */
  connectNudge: chatConnectNudgeSchema.optional().catch(undefined),
  /** The narration segment this call follows (see `chatDeltaSchema.segmentIndex`). */
  segmentIndex: z.number().int().nonnegative().default(0),
  /**
   * The row id an executed artifact tool created or edited.
   * Binds the live artifact stream, keyed by `toolCallId`, to the synced row.
   */
  artifactId: z.string().min(1).max(200).optional(),
  /** Set when a sub-agent made this call, so the client nests it under the spawn card. */
  subAgent: chatToolSubAgentSchema.optional(),
});

/**
 * Live growth of a `document` artifact's `markdown` argument while the model writes it.
 * Keyed by `toolCallId`, because `create_artifact` has no artifact id until it runs.
 * Ephemeral, like `chat.delta`. `pages`/HTML artifacts do not stream here.
 */
export const artifactDeltaSchema = z.object({
  runId: z.string().min(1).max(120),
  threadId: z.string().min(1).max(120),
  toolCallId: z.string().min(1).max(200),
  seq: z.number().int().nonnegative(),
  /** Markdown since the previous delta for this toolCallId, not the full body. */
  text: z.string().max(CHAT_DELTA_MAX),
  /** `replace`: the streamed text is the whole body. `append`: a new section after it. */
  mode: z.enum(["replace", "append"]),
  /** Known once the args reveal it (create/update). */
  title: z.string().max(200).optional(),
  /** From the args for append/update. For create, bound by the `chat.tool` succeeded event. */
  artifactId: z.string().min(1).max(200).optional(),
});

/**
 * Lifecycle of the assistant message behind a chat turn.
 * `completed` means the durable copy is saved.
 * `capacity_retry` fires on a 429 or 5xx before any output, ahead of a backoff.
 * The backoff outlasts the client's 45s stall watchdog, so this frame re-arms it.
 */
export const chatMessageSchema = z.object({
  runId: z.string().min(1).max(120),
  threadId: z.string().min(1).max(120),
  messageId: z.string().min(1).max(120),
  phase: z.enum([
    "started",
    "compaction_started",
    "compaction_finished",
    "capacity_retry",
    "completed",
  ]),
  /** Only on the compaction phases. */
  compactionScope: z.enum(["foreground", "within_run"]).optional(),
});

export const eventPayloadSchemas = {
  "agent.progress": agentProgressSchema,
  "agent.run": agentRunSchema,
  "tool.call": toolCallSchema,
  "approval.requested": approvalRequestedSchema,
  "memory.fact_learned": memoryFactLearnedSchema,
  "inbox.updated": inboxUpdatedSchema,
  "chat.delta": chatDeltaSchema,
  "chat.reasoning": chatReasoningSchema,
  "chat.tool": chatToolSchema,
  "chat.message": chatMessageSchema,
  "artifact.delta": artifactDeltaSchema,
} as const satisfies Record<string, z.ZodType>;

export type EventKind = keyof typeof eventPayloadSchemas;

export type EventPayload<K extends EventKind> = z.infer<(typeof eventPayloadSchemas)[K]>;

export const EVENT_KINDS =
  // SAFETY: EventKind is `keyof typeof eventPayloadSchemas`, so these keys are exactly EventKind.
  Object.freeze(Object.keys(eventPayloadSchemas) as EventKind[]);

export const eventFrameSchema = z.object({
  id: z.number().int().positive(),
  kind: z.custom<EventKind>((value) => isKnownEventKind(value), {
    message: "must be a known event kind",
  }),
  payload: z.unknown(),
  createdAt: z.string(),
});

export type EventFrame = z.infer<typeof eventFrameSchema>;

export function isKnownEventKind(value: unknown): value is EventKind {
  return (
    typeof value === "string" && Object.prototype.hasOwnProperty.call(eventPayloadSchemas, value)
  );
}
