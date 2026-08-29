import { isInternalWorkflowSlug } from "@alfred/assistant/execution";
import {
  workflowRevisions,
  workflows,
  type Workflow,
  type WorkflowRevision,
} from "@alfred/db/schemas";
import { SYNC_MODEL } from "@alfred/sync";
import { asc, eq } from "drizzle-orm";
import { syncEntity } from "./sync-entity";

type WorkflowRow = { workflow: Workflow; currentRevision: WorkflowRevision | null };

// Both built-in and user-authored rows sync (m13 Phase 8). The editor
// only mutates `is_builtin = false` rows; built-ins render read-only.
// Keyed by `slug` so the editor's optimistic write addresses the row
// without an id lookup, matching the `/workflows/$workflow` route param.
export const fetchWorkflows = syncEntity(SYNC_MODEL.workflow, {
  query: async (tx, userId) => {
    const rows: WorkflowRow[] = await tx
      .select({ workflow: workflows, currentRevision: workflowRevisions })
      .from(workflows)
      .leftJoin(workflowRevisions, eq(workflows.currentRevisionId, workflowRevisions.id))
      .where(eq(workflows.userId, userId))
      .orderBy(asc(workflows.slug));
    return rows.filter((r) => !isInternalWorkflowSlug(r.workflow.slug));
  },
  map: ({ workflow: w, currentRevision }: WorkflowRow) => ({
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
});
