import { z } from "zod";

/**
 * Public input schema + slug for the email-triage workflow. Lives in the
 * api package (not the workflow file under apps/server) so callers that
 * enqueue runs — ingest path, webhook handler, smoke scripts — don't need
 * to import from `apps/server`.
 */

export const TRIAGE_WORKFLOW_SLUG = "email-triage";

export const triageWorkflowInputSchema = z.object({
  documentId: z.string().min(1),
  /** Optional reason metadata — `ingest`, `webhook`, `manual`, `reply`. */
  reason: z
    .enum(["ingest", "webhook", "manual", "reply"])
    .optional(),
});
export type TriageWorkflowInput = z.infer<typeof triageWorkflowInputSchema>;
