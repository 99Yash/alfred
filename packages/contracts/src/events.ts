import { z } from "zod";
import { chatConnectNudgeSchema } from "./chat";
import { sanitizeErrorMessage } from "./sanitize";

export const CHAT_DELTA_MAX = 16_000;

/**
 * Caps for the tool identity a `chat.tool` event carries. Exported because the
 * *publisher* has to clamp to them: both strings come from the provider stream,
 * a model can invent a name of any length, and `publishEvent` throws on a
 * payload the schema rejects — inside an awaited commit hook that would fail the
 * whole run instead of letting the bad call bounce and self-correct (ADR-0070 /
 * #267). See `toolCardStarted` / `toolCardTerminal` in `@alfred/assistant`.
 */
export const CHAT_TOOL_NAME_MAX = 120;
export const CHAT_TOOL_CALL_ID_MAX = 200;

/**
 * Discriminated union of every event kind that flows through the durable
 * outbox -> Redis Pub/Sub -> SSE pipeline.
 *
 * Replicache pokes are intentionally absent. They have a separate, lower-
 * latency bus.
 */
export const agentProgressSchema = z.object({
  runId: z.string().min(1).max(120),
  step: z.string().min(1).max(120),
  message: z.string().max(2_000).optional(),
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
  approvalKind: z.enum(["step", "action_staging"]),
  prompt: z.string().min(1).max(4_000),
});

/**
 * Cap for the `error` string an `agent.run` frame carries. The *publisher* has
 * to clamp to it: the string comes from a step-body or resolve-failure throw of
 * any length, and `publishEvent` throws on a payload the schema rejects — inside
 * an awaited commit hook that rolls back the terminal `failed` write and
 * re-enters the reclaim loop. The bound is no longer a constant a caller must
 * remember to apply: {@link boundAgentRunError} is the sole minter of the
 * branded {@link AgentRunError} the frame's `error` field now demands, so a raw
 * `string` at any publisher is a type error, not a runtime `safeParse` throw.
 * The minter also feeds the persisted `error.message` twin, so both carry the
 * identical bounded string (ADR-0070 §8). Mirrors `CHAT_TOOL_NAME_MAX`.
 */
export const AGENT_RUN_ERROR_MAX = 4_000;

/**
 * The `error` field of an `agent.run` frame. Branded so a plain `string` is not
 * assignable: the only door to the brand is {@link boundAgentRunError}, which
 * runs the ADR-0070 null-byte strip and the {@link AGENT_RUN_ERROR_MAX} bound.
 * The brand is type-only — `safeParse` still enforces `.max()` and returns the
 * string unchanged, and a branded string is assignable to `string`, so no
 * consumer or persisted read changes.
 */
export const agentRunErrorSchema = z.string().max(AGENT_RUN_ERROR_MAX).brand<"AgentRunError">();
export type AgentRunError = z.infer<typeof agentRunErrorSchema>;

/**
 * The sole minter of {@link AgentRunError}. Strips ADR-0070 poison and bounds to
 * {@link AGENT_RUN_ERROR_MAX} in one call, so the branded result is
 * stripped-and-≤cap by construction — the cast is the standard branded-minter
 * idiom (mirrors `parseIanaTimezone`). A publisher mints its `error` here; a
 * plain string cannot reach the payload.
 */
export function boundAgentRunError(raw: string): AgentRunError {
  // SAFETY: sanitizeErrorMessage strips ADR-0070 poison and bounds to the cap;
  // AgentRunError brands exactly that contract.
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
 * The Gmail inbox view has changed in a way that warrants a re-fetch.
 *
 *  - `reason: 'ingested'` — one or more new documents were inserted by the
 *    ingest worker (`gmail.poll_recent` / `poll_history` / `ingest_recent`).
 *  - `reason: 'triaged'` — the triage workflow classified a thread and the
 *    row's category chip may have changed.
 *
 * Publishers should coalesce: emit at most once per ingestion job or per
 * triage run rather than per document. The client invalidates the rail's
 * `["me","inbox"]` React Query on receipt; the payload is deliberately
 * minimal so we don't try to do partial client-side merges.
 */
export const inboxUpdatedSchema = z.object({
  reason: z.enum(["ingested", "triaged"]),
  /** Best-effort count of affected docs for telemetry — not load-bearing. */
  count: z.number().int().nonnegative().max(10_000).optional(),
});

/**
 * Interactive-chat streaming events. These ride the same durable outbox →
 * Redis → SSE pipeline as the agent lifecycle events, scoped to a chat
 * thread + the agent run servicing the latest turn.
 *
 * `chat.delta` carries a *coalesced* text chunk, not a single token — the
 * worker buffers model output and flushes every ~200ms so we don't write one
 * outbox row per token. `seq` is monotonic per (runId, messageId) so the
 * client can order/dedupe deltas. The assistant message is also persisted via
 * Replicache on completion; streamed deltas are ephemeral UI reconciled
 * against that durable copy.
 */
export const chatDeltaSchema = z.object({
  runId: z.string().min(1).max(120),
  threadId: z.string().min(1).max(120),
  messageId: z.string().min(1).max(120),
  seq: z.number().int().nonnegative(),
  text: z.string().max(CHAT_DELTA_MAX),
  /**
   * Which narration segment this text belongs to. A turn's text is split into
   * segments at tool-call boundaries: segment N is the brief narration the
   * model writes before its Nth tool step, and the final (highest) segment is
   * the answer. The client interleaves the closed narration segments with the
   * tool cards in the activity trail and renders the answer below. Defaults to
   * 0 so a plain no-tool turn streams exactly as before.
   */
  segmentIndex: z.number().int().nonnegative().default(0),
});

/**
 * `chat.reasoning` carries a coalesced chunk of the model's thinking — the
 * same buffer/flush treatment as `chat.delta`, on its own `seq` so the client
 * orders reasoning independently of the reply text. Reasoning streams *before*
 * the answer (and may interleave around tool calls); the UI renders it in a
 * collapsible "Thinking…" accordion. Persisted alongside the durable message
 * so a reload can re-show "Thought for Ns".
 */
export const chatReasoningSchema = z.object({
  runId: z.string().min(1).max(120),
  threadId: z.string().min(1).max(120),
  messageId: z.string().min(1).max(120),
  seq: z.number().int().nonnegative(),
  text: z.string().max(CHAT_DELTA_MAX),
});

/**
 * Attribution for a tool call made by a spawned sub-agent rather than by the
 * boss itself (ADR-0016/0073). Present only on `chat.tool` events published by
 * a child run; absent on the boss's own calls.
 *
 * The enclosing event still carries the PARENT's `runId` / `threadId` /
 * `messageId` — the child has no thread of its own, and the client keys its
 * in-flight turn on (messageId, runId), so a child publishing its own runId
 * would look like a brand-new turn and reset the bubble. The child's identity
 * lives here instead, which is also what lets the client nest the call under
 * the `system.spawn_sub_agent` card that started it.
 */
export const chatToolSubAgentSchema = z.object({
  /** The parent's `system.spawn_sub_agent` call — the card this nests under. */
  parentToolCallId: z.string().min(1).max(200),
  /** The sub-agent's id within the parent turn (`sub_a`), for the trail label. */
  subId: z.string().min(1).max(64),
  /** The child `agent_runs` row, so lifecycle (`agent.run`) frames can be matched to this trail. */
  childRunId: z.string().min(1).max(120),
});

/**
 * A tool call inside a chat turn, surfaced as a live card. `started` fires
 * when the agent emits the call (with a preview of its input), `succeeded` /
 * `failed` when the dispatcher returns. Write actions that need approval do
 * NOT resolve here — they interrupt the run and emit `approval.requested`.
 */
export const chatToolSchema = z.object({
  runId: z.string().min(1).max(120),
  threadId: z.string().min(1).max(120),
  messageId: z.string().min(1).max(120),
  toolCallId: z.string().min(1).max(CHAT_TOOL_CALL_ID_MAX),
  toolName: z.string().min(1).max(CHAT_TOOL_NAME_MAX),
  status: z.enum(["started", "succeeded", "failed"]),
  /** Trimmed JSON preview of the tool input — never the full args blob. */
  argsPreview: z.string().max(2_000).optional(),
  /** Trimmed preview of the tool result for the card's done state. */
  resultPreview: z.string().max(2_000).optional(),
  /**
   * ADR-0070: the dispatch-boundary sanitizer stripped non-text bytes (U+0000 /
   * lone surrogates) from this result before storage, so the card can flag the
   * preview as possibly-incomplete instead of looking pristine. Absent/false on
   * clean results.
   */
  sanitized: z.boolean().optional(),
  /**
   * The dispatcher rejected this call before execution. The client retracts
   * any optimistic `started` card; the rejection remains in server traces and
   * the model transcript for self-correction.
   */
  nonExecution: z.boolean().optional(),
  /**
   * Set together with `nonExecution` when the bounce was connection health
   * (`not_connected` / `needs_reauth` / `missing_scope`): the user-meaningful
   * repair, so the chat can offer a connect nudge for this envelope instead of
   * only narrating it. Absent on every other rejection — dispatcher plumbing
   * stays hidden. The slug is a closed enum. A frame from a server whose
   * registry knows a slug this bundle does not must still parse, so the
   * retraction lands and only the repair is dropped; `parseEventFrame` drops
   * the whole frame on a payload failure.
   */
  connectNudge: chatConnectNudgeSchema.optional().catch(undefined),
  /**
   * The narration segment this call follows (see `chatDeltaSchema.segmentIndex`)
   * so the client can order the card relative to the model's interleaved
   * narration. Defaults to 0.
   */
  segmentIndex: z.number().int().nonnegative().default(0),
  /**
   * For an executed artifact-authoring tool (`create_artifact` etc.): the row
   * id the call created or edited. Lets the client bind a live artifact stream
   * (keyed by `toolCallId`, which is all `create_artifact` has before it runs)
   * to its durable synced `artifacts` row. Absent on non-artifact tools and on
   * non-executed (nonExecution) results.
   */
  artifactId: z.string().min(1).max(200).optional(),
  /**
   * Set when a spawned sub-agent — not the boss — made this call, so the client
   * nests it under the `system.spawn_sub_agent` card instead of appending it to
   * the turn's top-level trail. See {@link chatToolSubAgentSchema}.
   */
  subAgent: chatToolSubAgentSchema.optional(),
});

/**
 * Live body of a `document` artifact as the boss authors it. The artifact body
 * is the `markdown` argument of `system.create_artifact` /
 * `append_artifact_section` / `update_artifact`; the SDK streams that argument
 * incrementally as `tool-input-delta` parts while the model generates, so the
 * worker extracts the growing `markdown` field and publishes its growth here.
 * This lets the sidebar fill token-by-token during authoring instead of the
 * body popping in whole when the tool finally executes (the v1 page-granularity
 * poke).
 *
 * Keyed by `toolCallId` because `create_artifact` has no artifact id until it
 * executes; for `append_artifact_section` / `update_artifact` the id is in the
 * tool args, so `artifactId` is carried from the first delta. The client binds
 * `create_artifact`'s id via the tool's `chat.tool` succeeded event (which now
 * carries `artifactId`). Ephemeral: reconciled against the durable synced
 * `artifacts` row on completion, exactly like `chat.delta`. `pages`/HTML
 * artifacts are not streamed here — they already appear at page granularity.
 */
export const artifactDeltaSchema = z.object({
  runId: z.string().min(1).max(120),
  threadId: z.string().min(1).max(120),
  toolCallId: z.string().min(1).max(200),
  seq: z.number().int().nonnegative(),
  /** Markdown appended since the previous delta for this toolCallId (not the full body). */
  text: z.string().max(CHAT_DELTA_MAX),
  /**
   * How the streamed text composes against the synced row:
   *  - `replace` (create/update): the streamed markdown *is* the whole body.
   *  - `append` (append_artifact_section): the streamed markdown is a new
   *    section to render after the existing synced content.
   */
  mode: z.enum(["replace", "append"]),
  /** The document title, extracted from the args; present once known (create/update). */
  title: z.string().max(200).optional(),
  /**
   * The target artifact id when the tool already carries one in its args
   * (`append_artifact_section` / `update_artifact`). Absent for
   * `create_artifact` until its `chat.tool` succeeded event binds it.
   */
  artifactId: z.string().min(1).max(200).optional(),
});

/**
 * Lifecycle of the assistant message backing a chat turn. `started` lets the
 * client mount the in-flight bubble keyed by `messageId`; `completed` signals
 * the durable message has been persisted (Replicache poke incoming) so the
 * client can reconcile the streamed bubble against the synced copy.
 */
export const chatMessageSchema = z.object({
  runId: z.string().min(1).max(120),
  threadId: z.string().min(1).max(120),
  messageId: z.string().min(1).max(120),
  phase: z.enum(["started", "compaction_started", "compaction_finished", "completed"]),
  /** Present only for the explicit compaction phases. */
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
  // SAFETY: EventKind is `keyof typeof eventPayloadSchemas`, so Object.keys of
  // that very table enumerates exactly the EventKind strings.
  Object.freeze(Object.keys(eventPayloadSchemas) as EventKind[]);

export const eventFrameSchema = z.object({
  id: z.number().int().positive(),
  kind: z.custom<EventKind>((value) => typeof value === "string" && isKnownEventKind(value), {
    message: "must be a known event kind",
  }),
  payload: z.unknown(),
  createdAt: z.string(),
});
export type EventFrame = z.infer<typeof eventFrameSchema>;

export function isKnownEventKind(value: string): value is EventKind {
  return Object.prototype.hasOwnProperty.call(eventPayloadSchemas, value);
}
