import type { TranscriptMessage } from "@alfred/ai";
import { ARTIFACT_DOCUMENT_DESIGN_PROMPT } from "@alfred/artifacts-design";
import {
  artifactFormatSchema,
  approvalReasonSchema,
  chatConnectNudgeSchema,
  scriptSourcesSchema,
  chatModelTierSchema,
  ianaTimezoneSchema,
  type ToolReadPath,
} from "@alfred/contracts";
import { sha256Hex } from "@alfred/db/hash";
import type { ChatMessageToolCall } from "@alfred/db/schemas";
import { z } from "zod";
import {
  foldToolSurfaceState,
  pendingToolCallSchema as basePendingToolCallSchema,
  toolSurfaceStateFields,
  type StepResult,
} from "@alfred/assistant/execution";
import type { IanaTimezone } from "@alfred/contracts";
import {
  isNewLocalDate,
  isTimeNoteDue,
  parkWaitSchema,
  resumeTimeNote,
  startTimeNote,
  TIME_NOTE_PAUSE_MS,
  type ParkWait,
} from "./turn-context";

/**
 * Durable chat turn state and the pure operations on it.
 * Separate from `chat-turn.ts` to avoid import cycles. Never import `./chat-turn` here.
 */

// Chat adds a narration `segmentIndex` to the shared pending call.
const pendingToolCallSchema = basePendingToolCallSchema.extend({
  /** Narration segment this call follows. */
  segmentIndex: z.number().int().nonnegative().default(0),
  /** The model of the step that proposed the call. Absent on a state saved before the field. */
  modelId: z.string().min(1).optional(),
});

export type PendingToolCall = z.infer<typeof pendingToolCallSchema>;

// `satisfies`: a key the persisted card declares and this shape lacks fails to compile,
// and so does a key this shape adds that the card does not declare. It checks keys, not
// value types. `nonExecution` and `verifiedRead` are the keys the sync wire drops on purpose.
const toolCallLogSchema = z.object({
  toolCallId: z.string(),
  toolName: z.string(),
  status: z.enum(["succeeded", "failed"]),
  argsPreview: z.string().optional(),
  resultPreview: z.string().optional(),
  // A pruned preview still parses, so persist the fact for reloads.
  resultTruncated: z.boolean().optional(),
  // The sanitizer stripped non-text bytes from the result (ADR-0070).
  sanitized: z.boolean().optional(),
  // A `failed` entry rejected before execution: malformed, invented, inactive, or disallowed.
  nonExecution: z.boolean().optional(),
  // A direct read that a `code_run` run sent into a script (ADR-0124). Not a failed write.
  verifiedRead: z.literal(true).optional(),
  // Connection-health rejection only (#378). `.catch`: a slug this build does not
  // know reads as no nudge instead of failing the whole state parse.
  connectNudge: chatConnectNudgeSchema.optional().catch(undefined),
  // Why a card asked (ADR-0130 amendment (c)). `.catch`: a bad value reads as none.
  approvalReason: approvalReasonSchema.optional().catch(undefined),
  // The web pages of a `code_run` script (ADR-0124). The preview prunes them, so they ride apart.
  scriptSources: scriptSourcesSchema.optional().catch(undefined),
  segmentIndex: z.number().int().nonnegative().default(0),
} satisfies Record<keyof ChatMessageToolCall | "nonExecution" | "verifiedRead", z.ZodType>);

export type ToolCallLogEntry = z.infer<typeof toolCallLogSchema>;

const narrationSegmentSchema = z.object({
  index: z.number().int().nonnegative(),
  text: z.string(),
});

/** `direct`: the read tools are on the surface. `code_run`: reads run only in `system.code_run`. */
const chatReadPathSchema = z.enum(["direct", "code_run" satisfies ToolReadPath]);

export type ChatReadPath = z.infer<typeof chatReadPathSchema>;

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
    // `selfIdentityGrounding` and the evidence map, snapshotted for the same reason. Empty on older
    // pinned runs.
    selfIdentity: z.string().optional(),
    // ADR-0124: how the run reads, from the user's flag on the first turn. The tool gate and the
    // prompt both follow it, so it is pinned with the prompt. Older runs read as `direct`.
    readPath: chatReadPathSchema.optional(),
    // ADR-0130 decision 6: the host paths of the `system.code_run` index, the reads that the run
    // can call. Pinned with the prompt, because a new tool description breaks the prompt cache.
    // Absent on a direct run and on an older pinned run: those keep the full index.
    codeRunIndex: z.array(z.string().min(1)).optional(),
    // Pins the system prompt for the whole run. Never cleared. Only a new build re-pins it: see
    // `assertStableChatSystem`.
    systemPromptHash: z
      .string()
      .regex(/^[a-f0-9]{64}$/)
      .optional(),
    // The hash of the code part of the pinned prompt: the prompt with no saved per-run values. It
    // includes the `readPath` choice. A change of it tells a new build from a drift in one build.
    // Absent on a run that an older build pinned.
    systemPromptCodeHash: z
      .string()
      .regex(/^[a-f0-9]{64}$/)
      .optional(),
    // `pdf` admits the PDF guide to the transcript.
    artifactDesignMedium: artifactFormatSchema.optional(),
    // Set by an artifact edit. A create can change the medium; the saved turn context stays.
    artifactMediumStale: z.literal(true).optional(),
    // The PDF guide enters the transcript once per run.
    pdfDesignGuideAdmitted: z.literal(true).optional(),
    // Snapshotted on the first turn. The terminal closure parses this state, so a bad stored
    // zone reads as absent there instead of skipping the failed-message finalize.
    timezone: ianaTimezoneSchema.optional().catch(undefined),
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
    /** What the current park waits on. The time note of the resumed run names it. */
    parkWait: parkWaitSchema.optional(),
    /**
     * A park that lasted the pause or longer, or that crossed a local midnight. The next model step
     * gets a time note for it.
     */
    pausedWait: z.object({ kind: parkWaitSchema, since: z.iso.datetime() }).optional(),
    /**
     * The latest instant that the transcript states: the send time of the user message, or the
     * latest time note. A change of its local date adds a note.
     */
    clockAnchor: z.iso.datetime().optional(),
    /** The start of the latest model step. A long gap before the next one adds a note. */
    lastModelStepAt: z.iso.datetime().optional(),
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

/** What {@link assertStableChatSystem} did with the pin. */
export type ChatSystemPin = "pinned" | "stable" | "repinned_on_build_change";

/**
 * Pin the system prompt for the run, and throw if it changed within one build.
 * `AlfredAgent` lives for one model step here, so its own check cannot see this.
 *
 * `codePrompt` is the same prompt with no saved per-run values, for the run's `readPath`.
 * - No pin yet: pin both hashes.
 * - The full hash is the same: stable. A run that an older build pinned gets its code hash here.
 * - The full hash and the code hash both changed, or the code hash is absent: a new build. Re-pin
 *   both hashes. This costs one cache miss. The caller logs it.
 * - Only the full hash changed: a drift within one build. Throw.
 */
export function assertStableChatSystem(
  state: Pick<ChatRunState, "systemPromptHash" | "systemPromptCodeHash">,
  systemPrompt: string,
  codePrompt: string,
): ChatSystemPin {
  const hash = sha256Hex(systemPrompt);
  const codeHash = sha256Hex(codePrompt);

  if (state.systemPromptHash === undefined) {
    state.systemPromptHash = hash;
    state.systemPromptCodeHash = codeHash;

    return "pinned";
  }

  if (state.systemPromptHash === hash) {
    state.systemPromptCodeHash ??= codeHash;

    return "stable";
  }

  if (state.systemPromptCodeHash !== codeHash) {
    state.systemPromptHash = hash;
    state.systemPromptCodeHash = codeHash;

    return "repinned_on_build_change";
  }

  throw new Error(
    "[chat] system prompt changed within a cache-stable chat run. " +
      "Keep changing context in the transcript; the system prompt must stay fixed for the whole run.",
  );
}

/** Reserve one guide message; the context guard admits it after compaction. */
export function admitPdfDesignGuide(
  state: Pick<ChatRunState, "artifactDesignMedium" | "pdfDesignGuideAdmitted">,
): TranscriptMessage | undefined {
  if (state.artifactDesignMedium !== "pdf" || state.pdfDesignGuideAdmitted) return;
  state.pdfDesignGuideAdmitted = true;

  // A trailing assistant message is an unsupported prefill on Anthropic, so use the user role.
  return { role: "user", content: ARTIFACT_DOCUMENT_DESIGN_PROMPT };
}

/** Build the only allowed chat interrupt and invalidate wake-sensitive state. */
export function interruptChatRun(
  state: ChatRunState,
  transcript: TranscriptMessage[],
  wake: Extract<StepResult<ChatRunState>, { kind: "interrupt" }>["wake"],
): Extract<StepResult<ChatRunState>, { kind: "interrupt" }> {
  // A signal wake is a sub-agent join; an HIL wake is an approval or a question.
  state.parkedAt = new Date().toISOString();
  state.parkKind = wake.kind === "hil" ? "gate" : "join";
  state.parkWait = parkWaitOf(wake);

  // An approval wait is the user's time, not the model's.
  if (state.parkKind === "gate") freezeReasoningMs(state, Date.now());

  return { kind: "interrupt", state, transcript, wake };
}

/**
 * Set the "Thought for Ns" duration once: from the claim to the first published reply text,
 * or to the first approval park if that comes first. It covers hidden reasoning and tool steps.
 * The client counts the same span live from the send ack.
 */
export function freezeReasoningMs(
  // The stream drain's structural state marks `startedAt` optional.
  state: Pick<ChatRunState, "reasoningMs"> & Partial<Pick<ChatRunState, "startedAt">>,
  now: number,
): void {
  if (state.reasoningMs > 0 || state.startedAt === undefined) return;
  const startedAtMs = Date.parse(state.startedAt);

  // Zero reads as "not set", so a same-millisecond reply still counts as set.
  if (Number.isFinite(startedAtMs)) state.reasoningMs = Math.max(1, now - startedAtMs);
}

function parkWaitOf(
  wake: Extract<StepResult<ChatRunState>, { kind: "interrupt" }>["wake"],
): ParkWait {
  if (wake.kind !== "hil") return "sub_agent";

  return wake.approvalKind === "question" ? "question" : "approval";
}

/**
 * Close a park on resume (#902). A join park counts as dispatch; an approval park
 * is human time and lands in `other`. A park of {@link TIME_NOTE_PAUSE_MS} or longer, or one that
 * crossed a local midnight, leaves a wait for the next time note (ADR-0130 amendment (f)).
 * Returns the gap.
 */
export function foldResumedPark(
  state: Pick<
    ChatRunState,
    "parkedAt" | "parkKind" | "parkWait" | "pausedWait" | "dispatchMs" | "timezone"
  >,
  now: number,
): number {
  if (state.parkedAt === undefined || state.parkKind === undefined) return 0;
  const parkedAtMs = Date.parse(state.parkedAt);
  const gap = Number.isFinite(parkedAtMs) ? Math.max(0, now - parkedAtMs) : 0;

  if (state.parkKind === "join") state.dispatchMs += gap;

  const crossedMidnight =
    state.timezone !== undefined &&
    gap > 0 &&
    isNewLocalDate(state.timezone, new Date(parkedAtMs), new Date(now));

  // An older checkpoint has no `parkWait`; its kind is the best guess.
  if (gap >= TIME_NOTE_PAUSE_MS || crossedMidnight) {
    state.pausedWait = {
      kind: state.parkWait ?? (state.parkKind === "join" ? "sub_agent" : "approval"),
      since: state.parkedAt,
    };
  }

  state.parkedAt = undefined;
  state.parkKind = undefined;
  state.parkWait = undefined;

  return gap;
}

/**
 * The `[system]` time note before a model step, if one is due (ADR-0130 amendment (f)). The note
 * goes at the end of the run transcript and is saved with the step, so it does not break the cache.
 *
 * - The first step: the anchor is the send time of the run's user message, not admission. A late
 *   start, for example a retry, gets a note when the pause or the date rule holds at that point.
 * - A later step: a park that left a wait, {@link TIME_NOTE_PAUSE_MS} or more since the previous
 *   model step, or a new local date since the anchor.
 */
export async function takeTimeNote(
  state: Pick<ChatRunState, "clockAnchor" | "pausedWait" | "startedAt" | "lastModelStepAt">,
  timezone: IanaTimezone,
  now: Date,
  /** The send time of the run's user message. Read only on the first step. */
  sentAt: () => Promise<Date | undefined>,
): Promise<string | undefined> {
  const previousStepAt =
    state.lastModelStepAt === undefined ? undefined : new Date(state.lastModelStepAt);

  state.lastModelStepAt = now.toISOString();

  if (state.clockAnchor === undefined) {
    const sent = await sentAt();

    if (sent === undefined || !isTimeNoteDue(timezone, sent, now)) {
      state.clockAnchor = (sent ?? now).toISOString();

      return;
    }

    state.clockAnchor = now.toISOString();

    return startTimeNote({ timezone, now, sentAt: sent });
  }

  const anchor = new Date(state.clockAnchor);
  const wait = state.pausedWait;

  const longStep =
    previousStepAt !== undefined && now.getTime() - previousStepAt.getTime() >= TIME_NOTE_PAUSE_MS;

  if (wait === undefined && !longStep && !isNewLocalDate(timezone, anchor, now)) return;
  state.clockAnchor = now.toISOString();
  state.pausedWait = undefined;

  return resumeTimeNote({
    timezone,
    now,
    runStartedAt: state.startedAt === undefined ? undefined : new Date(state.startedAt),
    wait: wait && { kind: wait.kind, since: new Date(wait.since) },
    previousStepAt: longStep ? previousStepAt : undefined,
  });
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
