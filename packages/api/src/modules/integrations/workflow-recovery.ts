import { toMessage } from "@alfred/contracts";
import { z } from "zod";

export const workflowRecoveryStateSchema = z
  .object({
    workflowId: z.string().min(1).max(200),
    revisionId: z.string().min(1).max(200),
  })
  .strict();

export const workflowRecoveryRequestSchema = workflowRecoveryStateSchema
  .extend({ userId: z.string().min(1).max(200) })
  .strict();

export type WorkflowRecoveryRequest = z.infer<typeof workflowRecoveryRequestSchema>;

export const workflowRecoveryResultSchema = z.discriminatedUnion("status", [
  z
    .object({
      status: z.enum(["ready", "blocked"]),
      workflowSlug: z.string().min(1).max(200),
      revisionId: z.string().min(1).max(200),
    })
    .strict(),
  z
    .object({
      status: z.literal("failure"),
      failureKind: z.string().min(1).max(100),
    })
    .strict(),
]);

export type WorkflowRecoveryResult = z.infer<typeof workflowRecoveryResultSchema>;

export type WorkflowRecoveryHandler = (
  request: WorkflowRecoveryRequest,
) => Promise<WorkflowRecoveryResult>;

let recoveryHandler: WorkflowRecoveryHandler | undefined;

/** Register the workflow adapter that runtime composition supplies. */
export function registerWorkflowRecoveryHandler(handler: WorkflowRecoveryHandler): () => void {
  if (recoveryHandler) {
    throw new Error("[integrations] a workflow recovery handler is already registered");
  }
  recoveryHandler = handler;

  return () => {
    if (recoveryHandler === handler) recoveryHandler = undefined;
  };
}

/**
 * Revalidate one workflow draft after a connection flow and select its SPA
 * redirect. Workflow result details stay behind the registered adapter; this
 * module owns only the connection-facing ready, blocked, and failure states.
 */
export async function resolveWorkflowRecoveryTarget(request: unknown): Promise<string> {
  const parsedRequest = workflowRecoveryRequestSchema.parse(request);
  try {
    if (!recoveryHandler) {
      throw new Error("[integrations] no workflow recovery handler is registered");
    }

    const recovered = workflowRecoveryResultSchema.parse(await recoveryHandler(parsedRequest));
    if (recovered.status === "failure") {
      return `/workflows?workflow_recovery=${encodeURIComponent(recovered.failureKind)}`;
    }

    return `/workflows/${encodeURIComponent(recovered.workflowSlug)}?workflow_recovery=${recovered.status}&revision_id=${encodeURIComponent(recovered.revisionId)}`;
  } catch (err) {
    console.warn(
      `[google.callback] failed to recover workflow ${parsedRequest.workflowId}:`,
      toMessage(err),
    );
    return "/workflows?workflow_recovery=failed";
  }
}
