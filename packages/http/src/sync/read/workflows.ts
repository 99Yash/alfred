import { isInternalWorkflowSlug } from "@alfred/assistant/execution";
import {
  workflowRevisions,
  workflows,
  type Workflow,
  type WorkflowRevision,
} from "@alfred/db/schemas";
import { syncedWorkflowSchema, type SyncedWorkflow } from "@alfred/sync";
import { asc, eq } from "drizzle-orm";
import { defineFetcher } from "./define-fetcher";
import { defineSerializer } from "./define-serializer";

type WorkflowRow = { workflow: Workflow; currentRevision: WorkflowRevision | null };

const serializeWorkflow = defineSerializer<WorkflowRow, SyncedWorkflow>(
  syncedWorkflowSchema,
  ({ workflow: w, currentRevision }) => ({
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
    lastRunAt: w.lastRunAt,
    lastRunStatus: w.lastRunStatus,
    nextRunAt: w.nextRunAt,
    rowVersion: w.rowVersion,
    createdAt: w.createdAt,
    updatedAt: w.updatedAt,
  }),
);

// Both built-in and user-authored rows sync (m13 Phase 8). The editor
// only mutates `is_builtin = false` rows; built-ins render read-only.
// Keyed by `slug` so the editor's optimistic write addresses the row
// without an id lookup, matching the `/workflows/$workflow` route param.
export const fetchWorkflows = defineFetcher<WorkflowRow>({
  slug: "WORKFLOW",
  query: async (tx, userId) => {
    const rows: WorkflowRow[] = await tx
      .select({ workflow: workflows, currentRevision: workflowRevisions })
      .from(workflows)
      .leftJoin(workflowRevisions, eq(workflows.currentRevisionId, workflowRevisions.id))
      .where(eq(workflows.userId, userId))
      .orderBy(asc(workflows.slug));
    return rows.filter((r) => !isInternalWorkflowSlug(r.workflow.slug));
  },
  idOf: ({ workflow }) => workflow.slug,
  versionOf: ({ workflow }) => workflow.rowVersion,
  serialize: serializeWorkflow,
});
