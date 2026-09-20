import { type Workflow } from "@alfred/assistant/execution";
import { TRIAGE_WORKFLOW_SLUG, triageWorkflowInputSchema } from "./workflow-input";
import {
  EMAIL_TRIAGE_INITIAL_STEP,
  emailTriageStateSchema,
  emailTriageSteps,
  type EmailTriageOperationState,
  type EmailTriageStepName,
} from "./workflow-operations";

export const emailTriageWorkflow: Workflow<EmailTriageOperationState, EmailTriageStepName> = {
  slug: TRIAGE_WORKFLOW_SLUG,
  name: "Email triage",
  description:
    "Classify an inbound Gmail message into one of ten categories and write the corresponding label back, keyed per-thread (ADR-0025).",
  trigger: { kind: "event", source: "gmail", type: "message_received" },
  initialStep: EMAIL_TRIAGE_INITIAL_STEP,
  // One declaration, shared with the step bodies: `EmailTriageOperationState`
  // is this schema's `z.infer`, so the persisted state and the state the
  // bodies read cannot drift apart (#1180 review).
  stateSchema: emailTriageStateSchema,
  closure: { kind: "none" },
  initialState(input) {
    const parsed = triageWorkflowInputSchema.parse(input.input ?? {});

    return {
      documentId: parsed.documentId,
      reason: parsed.reason,
      force: parsed.force,
    };
  },
  steps: emailTriageSteps,
};
