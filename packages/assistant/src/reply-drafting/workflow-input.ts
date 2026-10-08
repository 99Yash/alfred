import { replyDraftInvocationSchema, replyDraftTriageSnapshotSchema } from "@alfred/contracts";
import { z } from "zod";

/** Input and slug for `reply-drafting` (ADR-0098). Separate so callers can name the run without the recipe. */

export const REPLY_DRAFTING_WORKFLOW_SLUG = "reply-drafting";

export const replyDraftingWorkflowInputSchema = z.object({
  documentId: z.string().min(1),
  sourceThreadId: z.string().min(1),
  /**
   * `post_triage`: started by the gate, with the snapshot it judged.
   * `manual`: smoke or explicit request; skips the flag and loads the current row.
   */
  invocation: replyDraftInvocationSchema,
  triage: replyDraftTriageSnapshotSchema.nullable().optional(),
});

export type ReplyDraftingWorkflowInput = z.infer<typeof replyDraftingWorkflowInputSchema>;
