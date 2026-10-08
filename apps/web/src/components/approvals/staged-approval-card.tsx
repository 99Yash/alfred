import type { SyncedActionStaging } from "@alfred/sync";
import { ApprovalCard } from "./approval-card";
import { asQuestionStaging } from "./ask-user";
import { QuestionApprovalCard } from "./question-approval-card";
import type { RecordedDecision } from "./use-approval-decision";

/**
 * Pick the card for a queue row (ADR-0099): a write is reviewed, a question answered.
 * Branch here so every queue picks the same way.
 */
export function StagedApprovalCard({
  staging,
  onDecide,
}: {
  staging: SyncedActionStaging;
  /** Throws with a message on failure. */
  onDecide: (decision: RecordedDecision) => Promise<void>;
}) {
  // An input that does not parse gets the write card, as in the chat tray.
  const question = asQuestionStaging(staging);

  return question ? (
    <QuestionApprovalCard question={question} onDecide={onDecide} />
  ) : (
    <ApprovalCard staging={staging} onDecide={onDecide} />
  );
}
