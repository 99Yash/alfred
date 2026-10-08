import type { ApprovalKind, ToolName } from "@alfred/contracts";
import type { ToolStagingPolicy } from "../registry";
import type { PriorRejectionStatus } from "./staging-store";

/**
 * What the staged path does differently per arm, so a new arm is one row (ADR-0099).
 * `join` and `fast_path` return before the staged path.
 */
export interface GatedArmPolicy {
  /** Park on approval whatever policy and tier say. */
  forcesApproval: boolean;
  /**
   * Statuses that suppress an identical retry in the same run. A question also
   * matches `expired`, because a re-ask would meet the same silence.
   */
  priorRejectionStatuses: readonly PriorRejectionStatus[];
  /** The `hil` wake kind, written once on the wake. */
  approvalKind: ApprovalKind;
  wakePrompt(toolName: ToolName): string;
  /**
   * How a `rejected` or `expired` row reads back. `unanswered` lets the model go on
   * with a stated assumption and is never a failed call.
   */
  settled: "rejection" | "unanswered";
  /** Trace reason for a `rejected` row with no reason. */
  rejectedWithoutReason: string;
}

export const STAGING_ARM = {
  staged: {
    forcesApproval: false,
    priorRejectionStatuses: ["rejected"],
    approvalKind: "action_staging",
    wakePrompt: (toolName) => `Approve ${toolName}`,
    settled: "rejection",
    rejectedWithoutReason: "rejected by user",
  },
  question: {
    forcesApproval: true,
    priorRejectionStatuses: ["rejected", "expired"],
    approvalKind: "question",
    wakePrompt: () => "Answer Alfred's questions",
    settled: "unanswered",
    rejectedWithoutReason: "dismissed by user",
  },
  fast_path: null,
  join: null,
} satisfies Record<ToolStagingPolicy, GatedArmPolicy | null>;
