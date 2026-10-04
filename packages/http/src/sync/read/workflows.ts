import { isInternalWorkflowSlug } from "@alfred/assistant/execution";
import {
  workflowRevisions,
  workflows,
  type Workflow,
  type WorkflowRevision,
} from "@alfred/db/schemas";
import { SYNC_MODEL } from "@alfred/sync";
import { and, asc, eq, inArray } from "drizzle-orm";
import { syncEntity } from "./sync-entity";

type WorkflowRow = { workflow: Workflow; currentRevision: WorkflowRevision | null };

const ownedByUser = (userId: string) => eq(workflows.userId, userId);

// Both built-in and user-authored rows sync (m13 Phase 8). The editor
// only mutates `is_builtin = false` rows; built-ins render read-only.
// Keyed by `slug` so the editor's optimistic write addresses the row
// without an id lookup, matching the `/workflows/$workflow` route param.
// The internal-slug filter runs on the version projection, which carries the
// `slug` anyway. The current-revision join is full-value work, so it belongs to
// the load stage and runs only for changed rows.
export const fetchWorkflows = syncEntity(SYNC_MODEL.workflow, {
  versionQuery: async (tx, userId) => {
    const rows = await tx
      .select({ slug: workflows.slug, rowVersion: workflows.rowVersion })
      .from(workflows)
      .where(ownedByUser(userId))
      .orderBy(asc(workflows.slug));

    return rows.filter((r) => !isInternalWorkflowSlug(r.slug));
  },
  loadQuery: async (tx, userId, changed) => {
    const rows: WorkflowRow[] = await tx
      .select({ workflow: workflows, currentRevision: workflowRevisions })
      .from(workflows)
      .leftJoin(workflowRevisions, eq(workflows.currentRevisionId, workflowRevisions.id))
      .where(
        and(
          ownedByUser(userId),
          inArray(
            workflows.slug,
            changed.map((v) => v.slug),
          ),
        ),
      )
      .orderBy(asc(workflows.slug));

    return rows;
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
