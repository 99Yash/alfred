import { senderContextSchema, triageCategorySchema } from "@alfred/contracts";
import { z } from "zod";
import { type Workflow } from "@alfred/assistant/execution";
import { TRIAGE_WORKFLOW_SLUG, triageWorkflowInputSchema } from "./workflow-input";
import { emailTriageSteps, type EmailTriageStepName } from "./workflow-operations";

const stateSchema = z.object({
  documentId: z.string(),
  reason: z.enum(["ingest", "webhook", "manual", "reply"]).optional(),
  sourceThreadId: z.string().optional(),
  category: triageCategorySchema.optional(),
  confidence: z.number().min(0).max(1).optional(),
  rationale: z.string().nullable().optional(),
  senderContext: senderContextSchema.optional(),
  force: z.boolean().optional(),
  /**
   * Whole-thread closure fact read once by `classify` on the reply re-eval and
   * consumed by `close-loop-todos` (ADR-0050). Absent on every non-reply run.
   */
  userAlreadyReplied: z.boolean().optional(),
});

type State = z.infer<typeof stateSchema>;

export const emailTriageWorkflow: Workflow<State, EmailTriageStepName> = {
  slug: TRIAGE_WORKFLOW_SLUG,
  name: "Email triage",
  description:
    "Classify an inbound Gmail message into one of ten categories and write the corresponding label back, keyed per-thread (ADR-0025).",
  trigger: { kind: "event", source: "gmail", type: "message_received" },
  initialStep: "classify",
  stateSchema,
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
