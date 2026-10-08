/**
 * Reply drafting (ADR-0098): gate, verifier, send-access check, workflow, post-triage
 * consumer, and decision trace. Triage never imports this; the seam is `email-triage.classified`.
 */

export { REPLY_DRAFTING_WORKFLOW_SLUG, replyDraftingWorkflowInputSchema } from "./workflow-input";

export type { ReplyDraftingWorkflowInput } from "./workflow-input";

export { decideReplyWorthiness, noDraftResult } from "./worthiness";

export type {
  ReplyStandingInstructionState,
  ReplyWorthinessDecision,
  ReplyWorthinessInput,
} from "./worthiness";

export { prepareReplyStaging, verifyReplyCandidate } from "./verifier";

export type {
  ReplyDraftCandidate,
  ReplyDraftClaim,
  ReplyStagingPlan,
  ReplyVerifierContext,
} from "./verifier";

export { checkGmailSendAccess } from "./access";

export type { GmailSendAccess } from "./access";

export { recordReplyDraftDecision, REPLY_DRAFT_DECISION_TRACE_KIND } from "./decision";

export { acceptEmailTriageClassified, replyDraftingTriggerConsumer } from "./post-triage";

// Registered by the composition root.
export { replyDraftingWorkflow } from "./workflow";
