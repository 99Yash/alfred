/**
 * Reply drafting (ADR-0025 #5, PRD #236, foundation #243; ADR-0097).
 *
 * Owns the reply-worthiness gate, the structural verifier, the Gmail send-access
 * check, the `reply-drafting` workflow recipe, the post-triage trigger consumer,
 * and the durable `reply_drafting.decision` trace. Depends on `triage`; triage
 * never imports this module — the seam is the `email-triage.classified` event.
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

// Product recipe owned by this module; registered by the composition root.
export { replyDraftingWorkflow } from "./workflow";
