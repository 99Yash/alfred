import {
  actionStagings,
  agentRuns,
  workflows,
  type ActionStaging,
  type AgentRunTrigger,
} from "@alfred/db/schemas";
import { syncedActionStagingSchema, type SyncedActionStaging } from "@alfred/sync";
import { and, asc, desc, eq, gte, inArray, isNotNull } from "drizzle-orm";
import { SerializationError, toEntityRow, type EntityFetcher } from "./entity-row";
import { toIso, toRequiredIso } from "./iso-date";

const RECENT_REJECTION_WINDOW_MS = 14 * 24 * 60 * 60 * 1000;

/** Brief preview cap on the synced card row — full text stays server-side. */
const BRIEF_PREVIEW_CHARS = 280;

// The approvals surface only syncs rows that still require a user
// decision. Autonomy rows may briefly be `pending` while the dispatcher
// is executing the tool; those are audit rows, not approval cards.
export const fetchActionStagings: EntityFetcher = async (tx, userId) => {
  const rows = await tx
    .select({
      staging: actionStagings,
      workflowSlug: agentRuns.workflowSlug,
      // Display name + provenance are derived read-only fields for the card
      // (ADR-0034 amendment 2026-05-31). `workflowName` left-joins so a
      // deleted/builtin workflow row doesn't drop the staging — the
      // serializer falls back to the slug.
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

  return rows.flatMap(
    (r: {
      staging: ActionStaging;
      workflowSlug: string;
      workflowName: string | null;
      trigger: AgentRunTrigger | null;
      brief: string | null;
    }) =>
      toEntityRow({
        slug: "ACTION_STAGING",
        id: r.staging.id,
        rowVersion: r.staging.rowVersion,
        serialize: () =>
          serializeActionStaging(r.staging, {
            workflowSlug: r.workflowSlug,
            workflowName: r.workflowName,
            trigger: r.trigger,
            brief: r.brief,
            recentRejection: recentRejections.get(r.staging.toolName) ?? null,
          }),
      }),
  );
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
function narrowTrigger(trigger: AgentRunTrigger | null): {
  kind: string;
  source?: string;
  type?: string;
} {
  if (!trigger) return { kind: "manual" };
  const source = "source" in trigger ? trigger.source : undefined;
  const type = "type" in trigger ? trigger.type : undefined;
  return {
    kind: trigger.kind,
    ...(source ? { source } : {}),
    ...(type ? { type } : {}),
  };
}

function serializeActionStaging(
  s: ActionStaging,
  provenance: {
    workflowSlug: string;
    workflowName: string | null;
    trigger: AgentRunTrigger | null;
    brief: string | null;
    recentRejection: RecentRejection | null;
  },
): SyncedActionStaging {
  if (s.status !== "pending") {
    throw new SerializationError(`cannot sync action staging with status '${s.status}'`);
  }
  const recentRejection = provenance.recentRejection;
  const brief = provenance.brief
    ? provenance.brief.length > BRIEF_PREVIEW_CHARS
      ? `${provenance.brief.slice(0, BRIEF_PREVIEW_CHARS - 1)}…`
      : provenance.brief
    : null;
  return syncedActionStagingSchema.parse({
    id: s.id,
    userId: s.userId,
    runId: s.runId,
    workflowSlug: provenance.workflowSlug,
    workflowName: provenance.workflowName ?? provenance.workflowSlug,
    trigger: narrowTrigger(provenance.trigger),
    brief,
    stepId: s.stepId,
    toolCallId: s.toolCallId,
    toolName: s.toolName,
    integration: s.integration,
    riskTier: s.riskTier,
    proposedInput: s.proposedInput,
    requiresApproval: s.requiresApproval,
    status: s.status,
    expiresAt: toIso(s.expiresAt),
    notifyAfterAt: toIso(s.notifyAfterAt),
    notifiedAt: toIso(s.notifiedAt),
    recentRejection: recentRejection
      ? {
          runId: recentRejection.runId,
          reason: recentRejection.reason,
          decidedAt: toRequiredIso(recentRejection.decidedAt, "actionStagings.decidedAt"),
        }
      : null,
    rowVersion: s.rowVersion,
    createdAt: toRequiredIso(s.createdAt, "actionStagings.createdAt"),
    updatedAt: toIso(s.updatedAt),
  });
}
