import {
  actionStagings,
  agentRuns,
  workflows,
  type ActionStaging,
  type AgentRunTrigger,
} from "@alfred/db/schemas";
import { and, asc, desc, eq, gte, inArray, isNotNull } from "drizzle-orm";
import { SerializationError } from "./entity-row";
import { syncEntity } from "./sync-entity";

const RECENT_REJECTION_WINDOW_MS = 14 * 24 * 60 * 60 * 1000;

/** Brief preview cap on the synced card row — full text stays server-side. */
const BRIEF_PREVIEW_CHARS = 280;

// The approvals surface only syncs rows that still require a user
// decision. Autonomy rows may briefly be `pending` while the dispatcher
// is executing the tool; those are audit rows, not approval cards.
type ActionStagingRow = {
  staging: ActionStaging;
  workflowSlug: string;
  workflowName: string | null;
  trigger: AgentRunTrigger | null;
  brief: string | null;
  recentRejection: RecentRejection | null;
};

interface RecentRejection {
  runId: string;
  reason: string | null;
  decidedAt: Date;
}

async function loadRecentRejectionsByTool(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  tx: any,
  userId: string,
  pendingRows: Array<{ staging: ActionStaging }>,
): Promise<Map<string, RecentRejection>> {
  if (pendingRows.length === 0) return new Map();

  const toolNames = Array.from(new Set(pendingRows.map((r) => r.staging.toolName)));
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

/**
 * Project the run trigger down to the display-only fields the card needs.
 * Never forwards `eventId`/`payload`/document ids (ADR-0034 amendment).
 */
interface NarrowedTrigger {
  kind: string;
  source?: string;
  type?: string;
}

function narrowTrigger(trigger: AgentRunTrigger | null): NarrowedTrigger {
  if (!trigger) return { kind: "manual" };
  const source = "source" in trigger ? trigger.source : undefined;
  const type = "type" in trigger ? trigger.type : undefined;
  return {
    kind: trigger.kind,
    ...(source ? { source } : {}),
    ...(type ? { type } : {}),
  };
}

export const fetchActionStagings = syncEntity<"ACTION_STAGING", ActionStagingRow>(
  "ACTION_STAGING",
  {
    query: async (tx, userId) => {
      const rows: Array<{
        staging: ActionStaging;
        workflowSlug: string;
        workflowName: string | null;
        trigger: AgentRunTrigger | null;
        brief: string | null;
      }> = await tx
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
            eq(actionStagings.userId, userId),
            eq(actionStagings.status, "pending"),
            eq(actionStagings.requiresApproval, true),
          ),
        )
        .orderBy(asc(actionStagings.id));

      const recentRejections = await loadRecentRejectionsByTool(tx, userId, rows);
      return rows.map(
        (r: {
          staging: ActionStaging;
          workflowSlug: string;
          workflowName: string | null;
          trigger: AgentRunTrigger | null;
          brief: string | null;
        }) => ({
          ...r,
          recentRejection: recentRejections.get(r.staging.toolName) ?? null,
        }),
      );
    },
    map: (row) => {
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
  },
);
