import type { SyncedActionStaging } from "@alfred/sync";
import { ApprovalCard } from "./approval-card";
import { asQuestionStaging } from "./ask-user";
import { QuestionApprovalCard } from "./question-approval-card";
import type { RecordedDecision } from "./use-approval-decision";

/**
 * One row of the approvals queue, drawn as whichever card the row is
 * (ADR-0099). A question and a write are the same staged row on the same
 * decision route, but they are not the same card: a write is reviewed and a
 * question is answered.
 *
 * The branch lives here, not at each queue, so `/approvals` and a workflow's
 * Approvals tab cannot pick differently. `onDecide` takes the whole
 * {@link RecordedDecision} union, which both cards accept because a handler
 * for the wider union serves either narrower one.
 */
export function StagedApprovalCard({
  staging,
  onDecide,
}: {
  staging: SyncedActionStaging;
  /** Resolves when the decision is recorded; throws with a message on failure. */
  onDecide: (decision: RecordedDecision) => Promise<void>;
}) {
  // A staged input that does not parse falls back to the write card rather
  // than to nothing — the same rule the chat tray applies.
  const question = asQuestionStaging(staging);
  return question ? (
    <QuestionApprovalCard question={question} onDecide={onDecide} />
  ) : (
    <ApprovalCard staging={staging} onDecide={onDecide} />
  );
}
