import { replyDraftInvocationSchema, replyDraftTriageSnapshotSchema } from "@alfred/contracts";
import { z } from "zod";

/**
 * Public input schema + slug for the `reply-drafting` workflow (ADR-0098).
 * Lives apart from the workflow file so the post-triage gate, the smoke
 * script, and the usage report can name the run without importing the recipe.
 */

export const REPLY_DRAFTING_WORKFLOW_SLUG = "reply-drafting";

export const replyDraftingWorkflowInputSchema = z.object({
  documentId: z.string().min(1),
  sourceThreadId: z.string().min(1),
  /**
   * `post_triage` runs are started by the gate after a worthy verdict and carry
   * the triage snapshot the verdict relied on. `manual` runs come from a smoke
   * or an explicit user request, bypass the feature flag, and load the current
   * triage row themselves.
   */
  invocation: replyDraftInvocationSchema,
  triage: replyDraftTriageSnapshotSchema.nullable().optional(),
});
export type ReplyDraftingWorkflowInput = z.infer<typeof replyDraftingWorkflowInputSchema>;
