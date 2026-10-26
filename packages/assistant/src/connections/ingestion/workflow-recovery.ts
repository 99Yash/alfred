import { getStringPath } from "@alfred/contracts";
import { z } from "zod";
import { bootPort } from "@alfred/assistant/boot-port";
import { logger } from "@alfred/logging";

export const workflowRecoveryStateSchema = z
  .object({
    workflowId: z.string().min(1).max(200),
    revisionId: z.string().min(1).max(200),
  })
  .strict();

export const workflowRecoveryRequestSchema = workflowRecoveryStateSchema
  .extend({ userId: z.string().min(1).max(200) })
  .strict();

type WorkflowRecoveryRequest = z.infer<typeof workflowRecoveryRequestSchema>;

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

const workflowRecoveryHandlerPort = bootPort<WorkflowRecoveryHandler>("workflow recovery handler");

/** Register the workflow adapter that runtime composition supplies. */
export function registerWorkflowRecoveryHandler(handler: WorkflowRecoveryHandler): () => void {
  return workflowRecoveryHandlerPort.install(handler);
}

/** Revalidate a workflow draft after a connection flow and pick its SPA redirect. */
export async function resolveWorkflowRecoveryTarget(request: unknown): Promise<string> {
  try {
    const parsedRequest = workflowRecoveryRequestSchema.parse(request);

    const recovered = workflowRecoveryResultSchema.parse(
      await workflowRecoveryHandlerPort.read()(parsedRequest),
    );

    if (recovered.status === "failure") {
      return `/workflows?workflow_recovery=${encodeURIComponent(recovered.failureKind)}`;
    }

    return `/workflows/${encodeURIComponent(recovered.workflowSlug)}?workflow_recovery=${recovered.status}&revision_id=${encodeURIComponent(recovered.revisionId)}`;
  } catch (err) {
    logger.warn(
      { err },
      `[google.callback] failed to recover workflow ${getStringPath(request, "workflowId") ?? "unknown"}`,
    );

    return "/workflows?workflow_recovery=failed";
  }
}
