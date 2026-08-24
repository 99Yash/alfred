import type {
  CancellationEnvelope,
  IntegrationSlug,
  ToolName,
  ToolUnavailabilityCode,
  UnknownEffectEnvelope,
  WakeCondition,
} from "@alfred/contracts";

import type { PublicAppError } from "@alfred/contracts/app-errors";
import type { ToolCallDispatchArgs } from "../index";

interface RejectedToolResult {
  status: "rejected_by_user";
  toolName: ToolName;
  proposedInput: unknown;
  reason: string;
  retryPolicy: "do_not_retry_identical";
}

interface InvalidInputToolResult {
  status: "invalid_input";
  toolName: ToolName;
  message: string;
  issues?: unknown | undefined;
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
      editedByUser: boolean;
      sanitized?: boolean;
    }
  | { kind: "failed"; stagingId: string | null; error: PublicAppError }
  | { kind: "rejected"; stagingId: string | null; result: RejectedToolResult }
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
       * The availability evaluator's own code when the floor refused on
       * connection health — the fact the `{status:"not_allowed"}` envelope
       * collapses away. Carried beside (never inside) `result`, so the
       * model-facing transcript envelope is unchanged; only the client-facing
       * connect nudge (#378 item 3) derives from it. Absent on workflow-cap
       * and resource-scope refusals, which are policy, not connection health.
       */
      unavailability?: ToolUnavailabilityCode;
    }
  | { kind: "feature_disabled"; result: FeatureDisabledToolResult };

export interface ToolCallRoundAdapter {
  dispatch(args: ToolCallDispatchArgs): Promise<ToolCallDispatchResult>;
  wouldWaitForApproval(userId: string, toolName: string): Promise<boolean>;
  executionLane(toolName: string): string | null;
}
