import type { ApprovalCause } from "../approval-rule";
import type {
  AskUserUnansweredResult,
  CancellationEnvelope,
  IntegrationSlug,
  ToolName,
  ToolUnavailabilityCode,
  UnknownEffectEnvelope,
  WakeCondition,
} from "@alfred/contracts";

import type { PublicAppError } from "@alfred/contracts/app-errors";
import type { ApprovalForecast } from "../approval-rule";
import type { ToolCallDispatchArgs } from "../index";
import type { RegisteredTool, ToolEffects } from "./registry";

export interface RejectedToolResult {
  status: "rejected_by_user";
  toolName: ToolName;
  proposedInput: unknown;
  reason: string;
  retryPolicy: "do_not_retry_identical";
  /** The interrupted attempt may have applied the write, even if this decision refused a retry. */
  mayHaveRun?: true;
}

/** A dismissed or expired question (ADR-0099). Not a failed call anywhere downstream. */
export type UnansweredQuestionsToolResult = AskUserUnansweredResult &
  Pick<RejectedToolResult, "toolName" | "retryPolicy">;

interface InvalidInputToolResult {
  status: "invalid_input";
  toolName: ToolName;
  message: string;
  issues?: unknown;
}

interface UnknownToolResult {
  status: "unknown_tool";
  toolName: string;
  message: string;
}

interface InactiveToolResult {
  status: "inactive_tool";
  toolName: ToolName;
  message: string;
  recovery: { kind: "activate_and_reissue"; toolName: ToolName };
}

interface NotAllowedToolResult {
  status: "not_allowed" | "capability_mismatch";
  toolName: ToolName;
  integration: IntegrationSlug;
  message: string;
}

interface FeatureDisabledToolResult {
  status: "feature_disabled";
  toolName: ToolName;
  integration: IntegrationSlug;
  message: string;
}

/**
 * The outcome of a call that waited on a card: why it asked, and the settings that remove it
 * (ADR-0130 decision 4). Only the `executed`, `failed`, and `rejected` arms carry it.
 */
export interface CardOutcome {
  approvalCause?: ApprovalCause | undefined;
}

/** Adapter-only protocol. Agent callers receive only completed-call facts. */
export type ToolCallDispatchResult =
  | (CardOutcome & {
      kind: "executed";
      stagingId: string | null;
      toolResult: unknown;
      /** Typed side data, live or replayed from the staging row. Never read from `toolResult`. */
      effects: ToolEffects;
      editedByUser: boolean;
      sanitized?: boolean;
      /** Set only after an approval edit: the input that ran, not the model's proposal. */
      executedInput?: unknown;
      /** Set only by the join arm: the child run it resolved. */
      joinedChildRunId?: string;
    })
  | (CardOutcome & {
      kind: "failed";
      stagingId: string | null;
      error: PublicAppError;
      /** Set only after an approval edit: the input that ran, not the model's proposal. */
      executedInput?: unknown;
    })
  | (CardOutcome & { kind: "rejected"; stagingId: string | null; result: RejectedToolResult })
  | { kind: "unanswered"; stagingId: string | null; result: UnansweredQuestionsToolResult }
  | {
      kind: "blocked";
      stagingId: string | null;
      result: UnknownEffectEnvelope;
    }
  | {
      kind: "fenced";
      stagingId: string | null;
      result: CancellationEnvelope;
    }
  | {
      kind: "staged";
      stagingId: string;
      wake: Extract<WakeCondition, { kind: "hil" }>;
    }
  | { kind: "parked"; wake: Extract<WakeCondition, { kind: "signal" }> }
  | {
      kind: "invalid_input";
      result: InvalidInputToolResult;
      /**
       * Set only when a `code_run` run refused a direct read (ADR-0124). The call only reads, from
       * durable state, so the finalize guard must not count it as a failed write.
       */
      verifiedRead?: true;
    }
  | { kind: "unknown_tool"; result: UnknownToolResult }
  | { kind: "inactive_tool"; result: InactiveToolResult }
  | {
      kind: "not_allowed";
      result: NotAllowedToolResult;
      /**
       * Set only for a connection-health refusal. Kept outside `result` so the
       * model-facing envelope stays the same; the connect nudge reads it.
       */
      unavailability?: ToolUnavailabilityCode;
    }
  | { kind: "feature_disabled"; result: FeatureDisabledToolResult };

/**
 * A call that `dispatchUnlessGated` did not run, because the live gate would stage a card.
 * It wrote no row. The round dispatches it again in its serial lane.
 */
export interface DeferredDispatch {
  kind: "deferred";
  /** Why the card would stage, and the settings that remove it (ADR-0130 decision 4). */
  approvalCause: ApprovalCause | null;
}

export interface ToolCallRoundAdapter {
  dispatch(args: ToolCallDispatchArgs): Promise<ToolCallDispatchResult>;
  /** Like `dispatch`, but returns `deferred` before any write when the call would stage a card. */
  dispatchUnlessGated(
    args: ToolCallDispatchArgs,
  ): Promise<ToolCallDispatchResult | DeferredDispatch>;
  forecastApproval(userId: string, toolName: string): Promise<ApprovalForecast>;
  /** The chat thread's full-autonomy flag, read live. No thread reads as `false`. */
  readFullAutonomy(
    run: Pick<ToolCallDispatchArgs, "userId" | "approvalThreadId">,
  ): Promise<boolean>;
  executionLane(toolName: string): NonNullable<RegisteredTool["executionLane"]> | null;
  artifactStreamMode(toolName: string): NonNullable<RegisteredTool["artifactStream"]> | null;
}
