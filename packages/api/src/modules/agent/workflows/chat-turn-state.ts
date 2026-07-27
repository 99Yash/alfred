import { createHash } from "node:crypto";
import {
  artifactFormatSchema,
  chatModelTierSchema,
  type AgentTranscriptMessage,
} from "@alfred/contracts";
import { z } from "zod";
import { migrateActiveTools, migrateRecordedToolNames, systemToolKernel } from "../tool-surface";
import type { StepResult } from "../types";
import { pendingToolCallSchema as basePendingToolCallSchema } from "./pending-tool-call";

/**
 * Durable state for the interactive chat turn, plus the handful of pure
 * operations that are *about* that state rather than about any one protocol.
 *
 * It lives here rather than in `chat-turn.ts` because every protocol module the
 * workflow orchestrates (join, closure, retry budgets, the finalize guards,
 * attachment hydration) needs `ChatRunState`, while `chat-turn.ts` imports all
 * of them. Keeping the schema in the workflow would make each of those an
 * import cycle. Nothing in this module may import `./chat-turn`.
 */

// The interactive chat turn extends the shared core (see `./pending-tool-call`)
// with a narration `segmentIndex`; the background brief has no narration.
const pendingToolCallSchema = basePendingToolCallSchema.extend({
  /** Narration segment this call follows (see `chatRunStateSchema.segmentIndex`). */
  segmentIndex: z.number().int().nonnegative().default(0),
});
export type PendingToolCall = z.infer<typeof pendingToolCallSchema>;

const toolCallLogSchema = z.object({
  toolCallId: z.string(),
  toolName: z.string(),
  status: z.enum(["succeeded", "failed"]),
  argsPreview: z.string().optional(),
  resultPreview: z.string().optional(),
  // A `failed` entry rejected before execution: malformed, invented, inactive,
  // or disallowed. The honesty guard excludes recovered entries so an internal
  // first attempt cannot make it claim a later, successful call failed.
  nonExecution: z.boolean().optional(),
  segmentIndex: z.number().int().nonnegative().default(0),
});

const narrationSegmentSchema = z.object({
  index: z.number().int().nonnegative(),
  text: z.string(),
});

export const chatRunStateSchema = z
  .object({
    threadId: z.string().min(1),
    messageId: z.string().min(1),
    // The triggering user message id (ADR-0072). Lets the failure path tell a
    // *current-turn* image attachment (recoverable by "Send without it") apart
    // from a *historical* one replayed in the transcript (recoverable only by a
    // new chat). Optional for legacy runs minted before this field existed.
    userMessageId: z.string().optional(),
    // Structured artifact target selected by the sidebar. This is run metadata,
    // never inferred from user-authored prose or attachment content.
    artifactTargetId: z.string().optional(),
    tier: chatModelTierSchema,
    // Persisted under an older deploy, so names may refer to tools that have
    // since been retired. The transform below drops anything not in today's registry.
    activeTools: z.array(z.string()).optional(),
    // Exact first-turn deterministic selections, persisted so #414 can measure
    // preload hits/misses against the durable transcript. Optional for legacy runs.
    preloadedTools: z.array(z.string()).default([]),
    // Read only while resuming checkpoints created before exact tool surfaces.
    activeIntegrations: z.array(z.string().min(1)).optional(),
    preloadApplied: z.boolean().default(false),
    allowedIntegrations: z.array(z.string()),
    // ADR-0053 connected summary, snapshotted once at run start (first turn) and
    // reused every turn so the system-prompt prefix stays cache-stable.
    connectedSummary: z.string().optional(),
    // SHA-256 of the cache-stable system prompt. AlfredAgent is constructed per
    // model step on this workflow, so its instance-local stability assertion
    // cannot compare chat turns; the durable workflow state owns that check.
    // Cleared only when an artifact mutation intentionally changes system
    // context. Optional for legacy checkpoints.
    systemPromptHash: z
      .string()
      .regex(/^[a-f0-9]{64}$/)
      .optional(),
    // Safe system guidance for the thread's existing artifacts (generated
    // ids/enums only). Refreshed after an artifact mutation so the next model step
    // cannot operate from stale target metadata.
    artifactsContext: z.string().optional(),
    // Exact selected artifact body, carried as a lower-trust assistant reference
    // message rather than system text. Empty when no artifact exists/was found.
    artifactReference: z.string().optional(),
    // Determines whether the PDF-only authoring guide belongs in the next model
    // prompt. Refreshed with the selected artifact context after mutations.
    artifactDesignMedium: artifactFormatSchema.optional(),
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
    // Set by the last dispatch round when it auto-activated ≥1 tool via an
    // inactive-tool bounce (#407). While true, the next chat-turn's lead-in text
    // is an internal reissue ("tools warming up, retrying") — machinery the
    // prompt forbids surfacing and PR 503 already hides on the tool-card channel
    // — so its narration segment and live deltas are withheld from the user.
    // Default false for runs minted before the field existed.
    reissuePending: z.boolean().default(false),
    reasoningText: z.string().default(""),
    reasoningMs: z.number().int().min(0).default(0),
    toolCallsLog: z.array(toolCallLogSchema).default([]),
    deltaSeq: z.number().int().min(0).default(0),
    reasoningSeq: z.number().int().min(0).default(0),
    turnCount: z.number().int().min(0).default(0),
    // Index where the current within-run tool burst begins. The persisted
    // foreground guard may replace the loaded transcript before the first model
    // call; subsequent tool-loop turns must continue from that prepared
    // transcript and compact only the older prefix when pressure grows.
    inFlightTailStart: z.number().int().min(0).default(0),
    // Consecutive empty completions retried this run (see CHAT_EMPTY_COMPLETION_MAX_RETRIES).
    // Reset to 0 whenever a turn is productive (tool calls or real text), so this
    // counts a provider stuck returning empties — not scattered empties across a
    // long turn loop. Default 0 for runs minted before the field existed.
    emptyCompletionRetries: z.number().int().min(0).default(0),
    // Consecutive stream-timeout retries this run (see STREAM_TIMEOUT_MAX_RETRIES).
    // Sibling of `emptyCompletionRetries`: reset to 0 on any productive turn, so
    // it counts retries of the *same* stuck turn — not one timeout per tool-loop
    // step. Default 0 for runs minted before the field existed.
    streamTimeoutRetries: z.number().int().min(0).default(0),
    startedAt: z.iso.datetime().optional(),
    // Read only while resuming checkpoints created before `startedAt`.
    started: z.boolean().optional(),
    // Instant the ephemeral `<runtime_context>` line — the chat run's single
    // source of the current date and time — is anchored to (#410). Held stable
    // across a contiguous execution slice so the tool-result tail stays
    // cacheable. Every interrupt clears it, so any resumed invocation re-stamps
    // to wake-time regardless of how short the park was. Absent on legacy runs.
    runtimeGroundingAnchor: z.iso.datetime().optional(),
    // ADR-0073 finalization guard: child runs spawned this turn whose outcomes
    // are already accounted for in the transcript — either folded by the guard, or
    // surfaced because the boss explicitly called `await_sub_agent` (a successful
    // await commits the child's real outcome as a normal tool result). Lets the
    // guard re-run on each resume without re-folding a child it already surfaced,
    // and stops it from injecting a false "finished without you awaiting it" note
    // for a child the boss did await.
    foldedChildRunIds: z.array(z.string()).default([]),
    // #346 honesty guard: toolCallIds of net-failed mutating calls the finalize
    // guard has already injected a "do not claim this succeeded" note for. Mirrors
    // `foldedChildRunIds` — tracking what's been handled keeps the guard idempotent
    // across resumes and stops it re-firing (and looping) on a failure it already
    // surfaced to the model.
    notedFailureToolCallIds: z.array(z.string()).default([]),
  })
  .transform(({ activeIntegrations, activeTools, preloadedTools, started, ...state }) => ({
    ...state,
    // The old boolean recorded only that the event fired. Runtime migration is
    // the best timestamp available for an already-started legacy checkpoint.
    startedAt: state.startedAt ?? (started ? new Date().toISOString() : undefined),
    activeTools: migrateActiveTools(
      activeTools,
      activeIntegrations,
      state.pendingToolCalls.map((call) => call.toolName),
    ),
    preloadedTools: migrateRecordedToolNames(preloadedTools).filter(
      (name) => !systemToolKernel().includes(name),
    ),
  }));
export type ChatRunState = z.infer<typeof chatRunStateSchema>;

/**
 * Own the chat path's cross-turn system stability invariant in durable state.
 * `AlfredAgent` is intentionally short-lived here (one instance per model
 * step), so its instance-local assertion cannot protect the prompt cache.
 */
export function assertStableChatSystem(
  state: Pick<ChatRunState, "systemPromptHash">,
  systemPrompt: string,
): void {
  const hash = createHash("sha256").update(systemPrompt).digest("hex");
  if (state.systemPromptHash === undefined) {
    state.systemPromptHash = hash;
    return;
  }
  if (state.systemPromptHash === hash) return;
  throw new Error(
    "[chat] system prompt changed within a cache-stable chat run. " +
      "Clear systemPromptHash only at the lifecycle seam that intentionally changes system context.",
  );
}

/** Build the only allowed chat interrupt and invalidate wake-sensitive state. */
export function interruptChatRun(
  state: ChatRunState,
  transcript: AgentTranscriptMessage[],
  wake: Extract<StepResult<ChatRunState>, { kind: "interrupt" }>["wake"],
): Extract<StepResult<ChatRunState>, { kind: "interrupt" }> {
  // A park is the real discontinuity. Clearing here makes even a millisecond
  // park refresh grounding, while a long uninterrupted tool loop retains it.
  state.runtimeGroundingAnchor = undefined;
  return { kind: "interrupt", state, transcript, wake };
}

/**
 * Close the current narration segment as a tool-bearing step ends: the lead-in
 * text was a preface to those tools, not the answer, so it moves onto the
 * narration trail and the segment index advances so later tool cards stay
 * aligned. When `reissuePending` is set the lead-in is instead an internal
 * reissue of just-auto-activated tools (#407) — machinery the prompt forbids
 * surfacing (see the "internal machinery" prompt rule) and PR 503 already hides
 * on the tool-card channel — so its text is dropped from the trail while the
 * index still advances. Pure so the drop/keep/advance behavior is unit-tested.
 *
 * Distinct from `closePrematureAnswerSegment` (see `./finalize-guards`), which
 * has a different keep/drop policy and emits an advance-delta — do not merge them.
 */
export function closeLeadInNarration(
  state: Pick<ChatRunState, "narration" | "assistantText" | "segmentIndex" | "reissuePending">,
): Pick<ChatRunState, "narration" | "assistantText" | "segmentIndex"> {
  const keep = !state.reissuePending && state.assistantText.trim().length > 0;
  return {
    narration: keep
      ? [...state.narration, { index: state.segmentIndex, text: state.assistantText }]
      : state.narration,
    assistantText: "",
    segmentIndex: state.segmentIndex + 1,
  };
}

/**
 * All of this turn's assistant prose in order: the closed narration segments
 * followed by the current segment. Used where the transcript needs the full
 * thing (e.g. a stopped turn); the persisted `content` keeps only the final
 * segment so the durable reply stays free of narration lead-ins.
 */
export function fullAssistantText(state: ChatRunState): string {
  return [...state.narration.map((n) => n.text), state.assistantText]
    .filter((t) => t.trim().length > 0)
    .join("\n\n");
}
