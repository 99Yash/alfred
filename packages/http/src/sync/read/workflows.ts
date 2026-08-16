import { isInternalWorkflowSlug } from "@alfred/assistant/execution";
import {
  workflowRevisions,
  workflows,
  type Workflow,
  type WorkflowRevision,
} from "@alfred/db/schemas";
import { syncedWorkflowSchema, type SyncedWorkflow } from "@alfred/sync";
import { asc, eq } from "drizzle-orm";
import { toEntityRow, type EntityFetcher } from "./entity-row";
import { toIso, toRequiredIso } from "./iso-date";

// Both built-in and user-authored rows sync (m13 Phase 8). The editor
// only mutates `is_builtin = false` rows; built-ins render read-only.
// Keyed by `slug` so the editor's optimistic write addresses the row
// without an id lookup, matching the `/workflows/$workflow` route param.
export const fetchWorkflows: EntityFetcher = async (tx, userId) => {
  const rows = await tx
    .select({ workflow: workflows, currentRevision: workflowRevisions })
    .from(workflows)
    .leftJoin(workflowRevisions, eq(workflows.currentRevisionId, workflowRevisions.id))
    .where(eq(workflows.userId, userId))
    .orderBy(asc(workflows.slug));
  return rows
    .filter(({ workflow }: { workflow: Workflow }) => !isInternalWorkflowSlug(workflow.slug))
    .flatMap(
      ({
        workflow,
        currentRevision,
      }: {
        workflow: Workflow;
        currentRevision: WorkflowRevision | null;
      }) =>
        toEntityRow({
          slug: "WORKFLOW",
          id: workflow.slug,
          rowVersion: workflow.rowVersion,
          serialize: () => serializeWorkflow(workflow, currentRevision),
        }),
    );
};

function serializeWorkflow(w: Workflow, currentRevision: WorkflowRevision | null): SyncedWorkflow {
  return syncedWorkflowSchema.parse({
    id: w.id,
    userId: w.userId,
    slug: w.slug,
    // The control row mirrors the published definition for dispatch. The
    // editor reads the current draft instead, so saving an active workflow
    // does not appear to revert on the next authoritative pull.
    name: currentRevision?.name ?? w.name,
    description: currentRevision?.description ?? w.description,
    trigger: currentRevision?.trigger ?? w.trigger,
    brief: currentRevision?.brief ?? w.brief,
    allowedIntegrations: currentRevision?.allowedIntegrations ?? w.allowedIntegrations,
    currentRevisionId: w.currentRevisionId,
    publishedRevisionId: w.publishedRevisionId,
    blocked: w.blocked,
    status: w.status,
    isBuiltin: w.isBuiltin,
    lastRunAt: toIso(w.lastRunAt),
    lastRunStatus: w.lastRunStatus,
    nextRunAt: toIso(w.nextRunAt),
    rowVersion: w.rowVersion,
    createdAt: toRequiredIso(w.createdAt, "workflows.createdAt"),
    updatedAt: toIso(w.updatedAt),
  });
}
