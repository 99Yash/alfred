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
import type { ToolCallDispatchArgs } from "../index";
import type { RegisteredTool, ToolEffects } from "./registry";

export interface RejectedToolResult {
  status: "rejected_by_user";
  toolName: ToolName;
  proposedInput: unknown;
  reason: string;
  retryPolicy: "do_not_retry_identical";
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

/** Adapter-only protocol. Agent callers receive only completed-call facts. */
export type ToolCallDispatchResult =
  | {
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
    }
  | {
      kind: "failed";
      stagingId: string | null;
      error: PublicAppError;
      /** Set only after an approval edit: the input that ran, not the model's proposal. */
      executedInput?: unknown;
    }
  | { kind: "rejected"; stagingId: string | null; result: RejectedToolResult }
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
  | { kind: "invalid_input"; result: InvalidInputToolResult }
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

export interface ToolCallRoundAdapter {
  dispatch(args: ToolCallDispatchArgs): Promise<ToolCallDispatchResult>;
  wouldWaitForApproval(userId: string, toolName: string): Promise<boolean>;
  executionLane(toolName: string): NonNullable<RegisteredTool["executionLane"]> | null;
  artifactStreamMode(toolName: string): NonNullable<RegisteredTool["artifactStream"]> | null;
}
