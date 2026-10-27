import { ApprovalCard } from "./approval-card";
import type { StagedRow } from "./ask-user";
import { QuestionApprovalCard } from "./question-approval-card";
import type { DecisionOutcome } from "./decide-approval";
import type { RecordedDecision } from "./use-approval-decision";

/**
 * Pick the card for a queue row (ADR-0099): a write is reviewed, a question answered.
 * Branch here so every queue picks the same way.
 */
export function StagedApprovalCard({
  row,
  onDecide,
}: {
  row: StagedRow;
  /** Throws with a message on failure. */
  onDecide: (decision: RecordedDecision) => Promise<DecisionOutcome>;
}) {
  return row.kind === "question" ? (
    <QuestionApprovalCard question={row} onDecide={onDecide} />
  ) : (
    <ApprovalCard staging={row.staging} onDecide={onDecide} />
  );
}
