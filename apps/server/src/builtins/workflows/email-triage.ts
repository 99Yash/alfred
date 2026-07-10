import {
  runEmailTriageApplyLabel,
  runEmailTriageClassify,
  triageWorkflowInputSchema,
  TRIAGE_WORKFLOW_SLUG,
  type Workflow,
} from "@alfred/api/backend";
import { senderContextSchema } from "@alfred/contracts";
import { TRIAGE_CATEGORIES } from "@alfred/integrations/google";
import { z } from "zod";

const stateSchema = z.object({
  documentId: z.string(),
  reason: z.enum(["ingest", "webhook", "manual", "reply"]).optional(),
  sourceThreadId: z.string().optional(),
  category: z.enum(TRIAGE_CATEGORIES).optional(),
  confidence: z.number().min(0).max(1).optional(),
  rationale: z.string().nullable().optional(),
  senderContext: senderContextSchema.optional(),
  force: z.boolean().optional(),
});
type State = z.infer<typeof stateSchema>;

export const emailTriageWorkflow: Workflow<State> = {
  slug: TRIAGE_WORKFLOW_SLUG,
  name: "Email triage",
  description:
    "Classify an inbound Gmail message into one of ten categories and write the corresponding label back, keyed per-thread (ADR-0025).",
  trigger: { kind: "event", source: "gmail", type: "message_received" },
  initialStep: "classify",
  stateSchema,
  initialState(input) {
    const parsed = triageWorkflowInputSchema.parse(input.input ?? {});
    return {
      documentId: parsed.documentId,
      reason: parsed.reason,
      force: parsed.force,
    };
  },
  steps: {
    classify: { id: "classify", run: runEmailTriageClassify },
    "apply-label": { id: "apply-label", run: runEmailTriageApplyLabel },
  },
};
