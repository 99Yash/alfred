import { createHash } from "node:crypto";
import { ARTIFACT_DOCUMENT_DESIGN_PROMPT } from "@alfred/artifacts-design";
import {
  artifactFormatSchema,
  chatConnectNudgeSchema,
  chatModelTierSchema,
  type AgentTranscriptMessage,
} from "@alfred/contracts";
import { z } from "zod";
import {
  foldToolSurfaceState,
  pendingToolCallSchema as basePendingToolCallSchema,
  RUNTIME_GROUNDING_PARK_GRACE_MS,
  toolSurfaceStateFields,
  type StepResult,
} from "@alfred/assistant/execution";

/**
 * Durable chat turn state and the pure operations on it.
 * Separate from `chat-turn.ts` to avoid import cycles. Never import `./chat-turn` here.
 */

// Chat adds a narration `segmentIndex` to the shared pending call.
const pendingToolCallSchema = basePendingToolCallSchema.extend({
  /** Narration segment this call follows. */
  segmentIndex: z.number().int().nonnegative().default(0),
});

export type PendingToolCall = z.infer<typeof pendingToolCallSchema>;

const toolCallLogSchema = z.object({
  toolCallId: z.string(),
  toolName: z.string(),
  status: z.enum(["succeeded", "failed"]),
  argsPreview: z.string().optional(),
  resultPreview: z.string().optional(),
  // A pruned preview still parses, so persist the fact for reloads.
  resultTruncated: z.boolean().optional(),
  // A `failed` entry rejected before execution: malformed, invented, inactive, or disallowed.
  nonExecution: z.boolean().optional(),
  // Connection-health rejection only (#378). `.catch`: a slug this build does not
  // know reads as no nudge instead of failing the whole state parse.
  connectNudge: chatConnectNudgeSchema.optional().catch(undefined),
  segmentIndex: z.number().int().nonnegative().default(0),
});

const narrationSegmentSchema = z.object({
  index: z.number().int().nonnegative(),
  text: z.string(),
});

// Defaults and optionals let older checkpoints still parse.
export const chatRunStateSchema = z
  .object({
    threadId: z.string().min(1),
    messageId: z.string().min(1),
    // Lets the failure path tell this turn's image from a replayed one (ADR-0072).
    userMessageId: z.string().optional(),
    // Set by the sidebar selection, never inferred from user prose.
    artifactTargetId: z.string().optional(),
    tier: chatModelTierSchema,
    ...toolSurfaceStateFields,
    // Snapshotted on the first turn so the system prompt stays fixed (ADR-0053).
    connectedSummary: z.string().optional(),
    // `selfIdentityGrounding`, snapshotted for the same reason. Empty on older pinned runs.
    selfIdentity: z.string().optional(),
    // Pins the system prompt for the whole run. Never cleared once set.
    systemPromptHash: z
      .string()
      .regex(/^[a-f0-9]{64}$/)
      .optional(),
    // Ephemeral per-turn text. Rebuilt after each artifact edit.
    artifactThreadFacts: z.string().optional(),
    // The selected artifact body, sent as a lower-trust assistant message, not system text.
    artifactReference: z.string().optional(),
    // `pdf` admits the PDF guide to the transcript.
    artifactDesignMedium: artifactFormatSchema.optional(),
    // The PDF guide enters the transcript once per run.
    pdfDesignGuideAdmitted: z.literal(true).optional(),
    // Snapshotted on the first turn. A plain string; parse with `parseIanaTimezone`.
    timezone: z.string().optional(),
    pendingToolCalls: z.array(pendingToolCallSchema),
    // The current segment only. At turn end this is the final answer.
    assistantText: z.string().default(""),
    // Closed segments: the lead-in lines before each tool step.
    narration: z.array(narrationSegmentSchema).default([]),
    segmentIndex: z.number().int().min(0).default(0),
    // The last round auto-activated a tool (#407), so the next turn's lead-in is
    // machinery. Its narration and live deltas are withheld.
    reissuePending: z.boolean().default(false),
    reasoningText: z.string().default(""),
    reasoningMs: z.number().int().min(0).default(0),
    toolCallsLog: z.array(toolCallLogSchema).default([]),
    deltaSeq: z.number().int().min(0).default(0),
    reasoningSeq: z.number().int().min(0).default(0),
    turnCount: z.number().int().min(0).default(0),
    // Where the current tool burst starts. Within-run compaction touches only the older prefix.
    inFlightTailStart: z.number().int().min(0).default(0),
    // Consecutive retries, bounded by `turn-budgets`. A productive turn resets all three.
    emptyCompletionRetries: z.number().int().min(0).default(0),
    streamTimeoutRetries: z.number().int().min(0).default(0),
    capacityRetries: z.number().int().min(0).default(0),
    startedAt: z.iso.datetime().optional(),
    // Read only while resuming checkpoints created before `startedAt`.
    started: z.boolean().optional(),
    // Phase thermometer (#902). Dispatch includes sub-agent join parks.
    generationMs: z.number().int().min(0).default(0),
    dispatchMs: z.number().int().min(0).default(0),
    // `other` is the residual of this after generation and dispatch.
    stepWallMs: z.number().int().min(0).default(0),
    parkedAt: z.iso.datetime().optional(),
    /** Why the run parked: `join` = sub-agent await, `gate` = HIL approval. */
    parkKind: z.enum(["join", "gate"]).optional(),
    // The instant `<runtime_context>` states (#410). Held stable so the cached tail survives.
    runtimeGroundingAnchor: z.iso.datetime().optional(),
    // Children whose outcome the transcript already has, folded or awaited (ADR-0073).
    foldedChildRunIds: z.array(z.string()).default([]),
    // Failures the honesty guard already noted (#346), so it never loops on one.
    notedFailureToolCallIds: z.array(z.string()).default([]),
  })
  .transform(({ started, ...state }) => ({
    ...foldToolSurfaceState(state),
    // The old boolean has no time, so "now" is the best guess.
    startedAt: state.startedAt ?? (started ? new Date().toISOString() : undefined),
  }));

export type ChatRunState = z.infer<typeof chatRunStateSchema>;

/**
 * Throw if the system prompt changed within the run.
 * `AlfredAgent` lives for one model step here, so its own check cannot see this.
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
      "Keep changing context in the transcript; the system prompt must stay fixed for the whole run.",
  );
}

/** Reserve one guide message; the context guard admits it after compaction. */
export function admitPdfDesignGuide(
  state: Pick<ChatRunState, "artifactDesignMedium" | "pdfDesignGuideAdmitted">,
): AgentTranscriptMessage | undefined {
  if (state.artifactDesignMedium !== "pdf" || state.pdfDesignGuideAdmitted) return;
  state.pdfDesignGuideAdmitted = true;

  // A trailing assistant message is an unsupported prefill on Anthropic, so use the user role.
  return { role: "user", content: ARTIFACT_DOCUMENT_DESIGN_PROMPT };
}

/** Build the only allowed chat interrupt and invalidate wake-sensitive state. */
export function interruptChatRun(
  state: ChatRunState,
  transcript: AgentTranscriptMessage[],
  wake: Extract<StepResult<ChatRunState>, { kind: "interrupt" }>["wake"],
): Extract<StepResult<ChatRunState>, { kind: "interrupt" }> {
  // Keep the grounding anchor: `foldResumedPark` knows the park length and decides.
  // A signal wake is a sub-agent join; an HIL wake is an approval.
  state.parkedAt = new Date().toISOString();
  state.parkKind = wake.kind === "hil" ? "gate" : "join";

  return { kind: "interrupt", state, transcript, wake };
}

/**
 * Close a park on resume (#902). A join park counts as dispatch; an approval park
 * is human time and lands in `other`. Clear the anchor only past
 * {@link RUNTIME_GROUNDING_PARK_GRACE_MS}. Returns the gap.
 */
export function foldResumedPark(
  state: Pick<ChatRunState, "parkedAt" | "parkKind" | "dispatchMs" | "runtimeGroundingAnchor">,
  now: number,
): number {
  if (state.parkedAt === undefined || state.parkKind === undefined) return 0;
  const parkedAtMs = Date.parse(state.parkedAt);
  const gap = Number.isFinite(parkedAtMs) ? Math.max(0, now - parkedAtMs) : 0;

  if (state.parkKind === "join") state.dispatchMs += gap;

  // Past the grace the cached prefix is gone anyway, so the re-stamp is free.
  if (gap >= RUNTIME_GROUNDING_PARK_GRACE_MS) state.runtimeGroundingAnchor = undefined;

  state.parkedAt = undefined;
  state.parkKind = undefined;

  return gap;
}

/** The two ways the lead-in close and the guard close differ. */
export interface NarrationClose {
  /** Keep the text on the trail. A withheld #407 lead-in is dropped; a streamed answer stays. */
  readonly keepText: boolean;
  /**
   * Advance `segmentIndex` even when nothing was kept. Tool steps must, so their
   * cards stay aligned. A guard with no text must not: nothing streamed there.
   */
  readonly advanceWhenNothingKept: boolean;
}

/** Close the current segment in place. Returns whether text went onto the trail. */
export function closeNarrationSegment(
  state: Pick<ChatRunState, "narration" | "assistantText" | "segmentIndex">,
  close: NarrationClose,
): boolean {
  const kept = close.keepText && state.assistantText.trim().length > 0;

  if (!kept && !close.advanceWhenNothingKept) return false;

  if (kept) {
    state.narration = [
      ...state.narration,
      { index: state.segmentIndex, text: state.assistantText },
    ];
  }

  state.assistantText = "";
  state.segmentIndex += 1;

  return kept;
}

/** End a tool step: its text was a lead-in, not the answer. A #407 reissue lead-in is dropped. */
export function closeLeadInNarration(
  state: Pick<ChatRunState, "narration" | "assistantText" | "segmentIndex" | "reissuePending">,
): void {
  closeNarrationSegment(state, {
    keepText: !state.reissuePending,
    advanceWhenNothingKept: true,
  });
}

/** All of this turn's prose in order. The persisted `content` keeps only the final segment. */
export function fullAssistantText(state: ChatRunState): string {
  return [...state.narration.map((n) => n.text), state.assistantText]
    .filter((t) => t.trim().length > 0)
    .join("\n\n");
}
