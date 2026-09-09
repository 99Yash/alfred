import type { ApprovalKind, ToolName } from "@alfred/contracts";
import type { ToolStagingPolicy } from "../registry";
import type { PriorRejectionStatus } from "./staging-store";

/**
 * What the staged path does differently per staging arm. The dispatcher's
 * routing switch returns for `join` and `fast_path` before the staged path, so
 * those two arms carry no gated policy. Every arm that reaches the staged path
 * names its whole difference here, so a fifth arm is one row, not a search for
 * every `tool.staging === ...` branch (ADR-0099).
 */
export interface GatedArmPolicy {
  /**
   * Park on approval whatever the policy mode and risk tier say. A `question`
   * always parks: a question the user never sees is not a question.
   */
  forcesApproval: boolean;
  /**
   * Row statuses the retry-suppression check matches for a byte-identical
   * repeat of the same input in the same run. A write matches `rejected` only,
   * so an expired write stays re-proposable. A question also matches `expired`,
   * because a re-asked question would park the turn on the same silence.
   */
  priorRejectionStatuses: readonly PriorRejectionStatus[];
  /** The `hil` wake kind the parked turn waits on. Written once, on the wake. */
  approvalKind: ApprovalKind;
  wakePrompt(toolName: ToolName): string;
  /**
   * How a `rejected` or `expired` row reads back to the model. A `rejection`
   * is a vetoed action the model must not retry. An `unanswered` result is a
   * question with no answer, which the model continues past on a stated
   * assumption; it is not a failed call anywhere downstream.
   */
  settled: "rejection" | "unanswered";
  /** Trace reason for a `rejected` row that carries no reason of its own. */
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
