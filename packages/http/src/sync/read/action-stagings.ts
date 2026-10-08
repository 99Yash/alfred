import type { DbTransaction } from "@alfred/db";
import {
  actionStagings,
  agentRuns,
  workflows,
  type ActionStaging,
  type AgentRunTrigger,
} from "@alfred/db/schemas";
import { isQuestionApproval } from "@alfred/contracts";
import { SYNC_MODEL, type SyncedActionStaging } from "@alfred/sync";
import { and, asc, desc, eq, gte, inArray, isNotNull } from "drizzle-orm";
import { SerializationError } from "./entity-row";
import { syncEntity } from "./sync-entity";

const RECENT_REJECTION_WINDOW_MS = 14 * 24 * 60 * 60 * 1000;

const BRIEF_PREVIEW_CHARS = 280;

// Only rows that need a decision. Autonomy rows can be `pending` briefly but are not cards.
// Both stages also inner-join `agentRuns`: a staging with no run is not synced.
const awaitingApproval = (userId: string) =>
  and(
    eq(actionStagings.userId, userId),
    eq(actionStagings.status, "pending"),
    eq(actionStagings.requiresApproval, true),
  );

type ActionStagingRow = {
  staging: ActionStaging;
  workflowSlug: string;
  workflowName: string | null;
  trigger: AgentRunTrigger | null;
  brief: string | null;
  recentRejection: RecentRejection | null;
};

type SelectedActionStagingRow = Omit<ActionStagingRow, "recentRejection">;

interface RecentRejection {
  runId: string;
  reason: string | null;
  decidedAt: Date;
}

async function loadRecentRejectionsByTool(
  tx: DbTransaction,
  userId: string,
  pendingRows: Array<{ staging: ActionStaging }>,
): Promise<Map<string, RecentRejection>> {
  if (pendingRows.length === 0) return new Map();

  // Skip questions: they share one tool name, so a dismissal would warn on every card (ADR-0099).
  const toolNames = Array.from(
    new Set(pendingRows.map((r) => r.staging.toolName).filter((name) => !isQuestionApproval(name))),
  );

  if (toolNames.length === 0) return new Map();
  const cutoff = new Date(Date.now() - RECENT_REJECTION_WINDOW_MS);

  const rows = await tx
    .select({
      toolName: actionStagings.toolName,
      runId: actionStagings.runId,
      reason: actionStagings.rejectReason,
      decidedAt: actionStagings.decidedAt,
    })
    .from(actionStagings)
    .where(
      and(
        eq(actionStagings.userId, userId),
        eq(actionStagings.status, "rejected"),
        inArray(actionStagings.toolName, toolNames),
        isNotNull(actionStagings.decidedAt),
        gte(actionStagings.decidedAt, cutoff),
      ),
    )
    .orderBy(desc(actionStagings.decidedAt));

  const byTool = new Map<string, RecentRejection>();

  for (const row of rows) {
    if (byTool.has(row.toolName) || !(row.decidedAt instanceof Date)) continue;
    byTool.set(row.toolName, {
      runId: row.runId,
      reason: row.reason,
      decidedAt: row.decidedAt,
    });
  }

  return byTool;
}

/** Display fields only. Never forward `eventId`, `payload` or document ids (ADR-0034 amendment). */
type NarrowedTrigger = SyncedActionStaging["trigger"];

function narrowTrigger(trigger: AgentRunTrigger | null): NarrowedTrigger {
  if (!trigger) return { kind: "manual" };
  const source = "source" in trigger ? trigger.source : undefined;
  const type = "type" in trigger ? trigger.type : undefined;
  const rawKind = "rawKind" in trigger ? trigger.rawKind : undefined;

  return {
    kind: trigger.kind,
    ...(source ? { source } : {}),
    ...(type ? { type } : {}),
    ...(rawKind ? { rawKind } : {}),
  };
}

export const fetchActionStagings = syncEntity(SYNC_MODEL.actionstaging, {
  // The run join is membership. Workflow and rejection joins are display, so only the load stage reads them.
  versionQuery: (tx, userId) =>
    tx
      .select({ id: actionStagings.id, rowVersion: actionStagings.rowVersion })
      .from(actionStagings)
      .innerJoin(agentRuns, eq(actionStagings.runId, agentRuns.id))
      .where(awaitingApproval(userId))
      .orderBy(asc(actionStagings.id)),
  loadQuery: async (tx, userId, changed) => {
    const rows: SelectedActionStagingRow[] = await tx
      .select({
        staging: actionStagings,
        workflowSlug: agentRuns.workflowSlug,
        workflowName: workflows.name,
        trigger: agentRuns.trigger,
        brief: agentRuns.brief,
      })
      .from(actionStagings)
      .innerJoin(agentRuns, eq(actionStagings.runId, agentRuns.id))
      .leftJoin(
        workflows,
        and(eq(workflows.userId, agentRuns.userId), eq(workflows.slug, agentRuns.workflowSlug)),
      )
      .where(
        and(
          awaitingApproval(userId),
          inArray(
            actionStagings.id,
            changed.map((v) => v.id),
          ),
        ),
      )
      .orderBy(asc(actionStagings.id));

    const recentRejections = await loadRecentRejectionsByTool(tx, userId, rows);

    return rows.map(
      (row): ActionStagingRow => ({
        ...row,
        recentRejection: recentRejections.get(row.staging.toolName) ?? null,
      }),
    );
  },
  map: (row: ActionStagingRow) => {
    const s = row.staging;

    if (s.status !== "pending") {
      throw new SerializationError(`cannot sync action staging with status '${s.status}'`);
    }

    const recentRejection = row.recentRejection;

    const brief = row.brief
      ? row.brief.length > BRIEF_PREVIEW_CHARS
        ? `${row.brief.slice(0, BRIEF_PREVIEW_CHARS - 1)}…`
        : row.brief
      : null;

    return {
      id: s.id,
      userId: s.userId,
      runId: s.runId,
      workflowSlug: row.workflowSlug,
      workflowName: row.workflowName ?? row.workflowSlug,
      trigger: narrowTrigger(row.trigger),
      brief,
      stepId: s.stepId,
      toolCallId: s.toolCallId,
      toolName: s.toolName,
      integration: s.integration,
      riskTier: s.riskTier,
      proposedInput: s.proposedInput,
      requiresApproval: s.requiresApproval,
      status: s.status,
      expiresAt: s.expiresAt,
      notifyAfterAt: s.notifyAfterAt,
      notifiedAt: s.notifiedAt,
      recentRejection: recentRejection
        ? {
            runId: recentRejection.runId,
            reason: recentRejection.reason,
            decidedAt: recentRejection.decidedAt,
          }
        : null,
      rowVersion: s.rowVersion,
      createdAt: s.createdAt,
      updatedAt: s.updatedAt,
    };
  },
});
