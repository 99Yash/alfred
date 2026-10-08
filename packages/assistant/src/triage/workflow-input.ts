import { z } from "zod";

/** Input schema and slug, apart from the workflow so enqueue callers import little. */

export const TRIAGE_WORKFLOW_SLUG = "email-triage";

/** Why the run started. The run state reuses this schema. */
export const triageRunReasonSchema = z.enum(["ingest", "webhook", "manual", "reply"]);

export type TriageRunReason = z.infer<typeof triageRunReasonSchema>;

export const triageWorkflowInputSchema = z.object({
  documentId: z.string().min(1),
  reason: triageRunReasonSchema.optional(),
  /** Backfills only: bypass the already-tagged skip and re-classify. */
  force: z.boolean().optional(),
});

export type TriageWorkflowInput = z.infer<typeof triageWorkflowInputSchema>;
