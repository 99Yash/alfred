import {
  actionStagings,
  agentRuns,
  notes,
  skillRevisions,
  skillRuns,
  skills,
  userFacts,
  userPreferences,
} from "@alfred/db/schemas";
import { IDB_KEY_NAMES, type IDBKeys } from "@alfred/sync";
import { and, asc, desc, eq, gte, inArray, isNotNull } from "drizzle-orm";

/**
 * One row's contribution to the patch: its row_version drives CVR diffing,
 * and `serialized` is the value Replicache writes to the client store.
 */
export interface EntityRow {
  id: string;
  rowVersion: number;
  serialized: Record<string, unknown>;
}

// Typed loosely so this accepts either the pool or a Drizzle tx handle.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type DbTx = any;

type EntityFetcher = (tx: DbTx, userId: string) => Promise<EntityRow[]>;

const RECENT_REJECTION_WINDOW_MS = 14 * 24 * 60 * 60 * 1000;

/**
 * Per-entity read model for Replicache pull.
 *
 * `satisfies Record<IDBKeys, EntityFetcher>` is load-bearing: adding a key to
 * `IDB_KEY` forces a fetcher here, so server pull cannot silently forget a
 * client-visible entity.
 */
const ENTITY_FETCHERS = {
  NOTE: async (tx, userId) => {
    const rows = await tx
      .select()
      .from(notes)
      .where(eq(notes.userId, userId))
      .orderBy(asc(notes.id));
    return rows.map((n: typeof notes.$inferSelect) => ({
      id: n.id,
      rowVersion: n.rowVersion,
      serialized: serializeNote(n),
    }));
  },

  // Only `proposed` + `confirmed` reach the client; rejected / edited /
  // superseded rows stay server-side as audit history.
  FACT: async (tx, userId) => {
    const rows = await tx
      .select()
      .from(userFacts)
      .where(
        and(eq(userFacts.userId, userId), inArray(userFacts.status, ["proposed", "confirmed"])),
      )
      .orderBy(asc(userFacts.id));
    return rows.map((f: typeof userFacts.$inferSelect) => ({
      id: f.id,
      rowVersion: f.rowVersion,
      serialized: serializeFact(f),
    }));
  },

  // Preferences are keyed by `(user_id, key)`; the IDB id is the pref key
  // so optimistic client writes can address rows without a lookup.
  PREFERENCE: async (tx, userId) => {
    const rows = await tx
      .select()
      .from(userPreferences)
      .where(eq(userPreferences.userId, userId))
      .orderBy(asc(userPreferences.key));
    return rows.map((p: typeof userPreferences.$inferSelect) => ({
      id: p.key,
      rowVersion: p.rowVersion,
      serialized: serializePreference(p),
    }));
  },

  SKILL: async (tx, userId) => {
    const rows = await tx
      .select()
      .from(skills)
      .where(eq(skills.userId, userId))
      .orderBy(asc(skills.id));
    return rows.map((s: typeof skills.$inferSelect) => ({
      id: s.id,
      rowVersion: s.rowVersion,
      serialized: serializeSkill(s),
    }));
  },

  SKILL_REVISION: async (tx, userId) => {
    const rows = await tx
      .select()
      .from(skillRevisions)
      .where(eq(skillRevisions.userId, userId))
      .orderBy(asc(skillRevisions.id));
    return rows.map((r: typeof skillRevisions.$inferSelect) => ({
      id: r.id,
      rowVersion: r.rowVersion,
      serialized: serializeSkillRevision(r),
    }));
  },

  SKILL_RUN: async (tx, userId) => {
    const rows = await tx
      .select()
      .from(skillRuns)
      .where(eq(skillRuns.userId, userId))
      .orderBy(asc(skillRuns.id));
    return rows.map((r: typeof skillRuns.$inferSelect) => ({
      id: r.id,
      rowVersion: r.rowVersion,
      serialized: serializeSkillRun(r),
    }));
  },

  // The approvals surface only syncs rows that still require a user
  // decision. Autonomy rows may briefly be `pending` while the dispatcher
  // is executing the tool; those are audit rows, not approval cards.
  ACTION_STAGING: async (tx, userId) => {
    const rows = await tx
      .select({
        staging: actionStagings,
        workflowSlug: agentRuns.workflowSlug,
      })
      .from(actionStagings)
      .innerJoin(agentRuns, eq(actionStagings.runId, agentRuns.id))
      .where(
        and(
          eq(actionStagings.userId, userId),
          eq(actionStagings.status, "pending"),
          eq(actionStagings.requiresApproval, true),
        ),
      )
      .orderBy(asc(actionStagings.id));

    const recentRejections = await loadRecentRejectionsByTool(tx, userId, rows);

    return rows.map((r: { staging: typeof actionStagings.$inferSelect; workflowSlug: string }) => ({
      id: r.staging.id,
      rowVersion: r.staging.rowVersion,
      serialized: serializeActionStaging(
        r.staging,
        r.workflowSlug,
        recentRejections.get(r.staging.toolName) ?? null,
      ),
    }));
  },
} satisfies Record<IDBKeys, EntityFetcher>;

export const SYNC_ENTITIES = IDB_KEY_NAMES.map((slug) => ({
  slug,
  fetchRows: ENTITY_FETCHERS[slug],
}));

const toIso = (d: Date | null | undefined): string | null =>
  d instanceof Date ? d.toISOString() : (d ?? null);

function serializeNote(n: {
  id: string;
  userId: string;
  text: string;
  rowVersion: number;
  createdAt: Date;
}): Record<string, unknown> {
  return {
    id: n.id,
    userId: n.userId,
    text: n.text,
    createdAt: toIso(n.createdAt),
    rowVersion: n.rowVersion,
  };
}

function serializeFact(f: typeof userFacts.$inferSelect): Record<string, unknown> {
  return {
    id: f.id,
    userId: f.userId,
    key: f.key,
    value: f.value,
    confidence: f.confidence,
    status: f.status,
    source: f.source,
    validFrom: toIso(f.validFrom),
    validUntil: toIso(f.validUntil),
    supersedesId: f.supersedesId,
    rowVersion: f.rowVersion,
    createdAt: toIso(f.createdAt),
    updatedAt: toIso(f.updatedAt),
  };
}

function serializePreference(p: typeof userPreferences.$inferSelect): Record<string, unknown> {
  return {
    key: p.key,
    userId: p.userId,
    value: p.value,
    source: p.source,
    rowVersion: p.rowVersion,
  };
}

function serializeSkill(s: typeof skills.$inferSelect): Record<string, unknown> {
  return {
    id: s.id,
    userId: s.userId,
    slug: s.slug,
    name: s.name,
    description: s.description,
    currentRevisionId: s.currentRevisionId,
    status: s.status,
    isBuiltin: s.isBuiltin,
    lastInvokedAt: toIso(s.lastInvokedAt),
    rowVersion: s.rowVersion,
    createdAt: toIso(s.createdAt),
    updatedAt: toIso(s.updatedAt),
  };
}

function serializeSkillRevision(r: typeof skillRevisions.$inferSelect): Record<string, unknown> {
  return {
    id: r.id,
    skillId: r.skillId,
    userId: r.userId,
    kind: r.kind,
    body: r.body,
    metadata: r.metadata,
    createdByRunId: r.createdByRunId,
    rowVersion: r.rowVersion,
    createdAt: toIso(r.createdAt),
  };
}

function serializeSkillRun(r: typeof skillRuns.$inferSelect): Record<string, unknown> {
  return {
    id: r.id,
    skillId: r.skillId,
    userId: r.userId,
    kind: r.kind,
    agentRunId: r.agentRunId,
    status: r.status,
    producedRevisionId: r.producedRevisionId,
    rowVersion: r.rowVersion,
    startedAt: toIso(r.startedAt),
    endedAt: toIso(r.endedAt),
  };
}

interface RecentRejection {
  runId: string;
  reason: string | null;
  decidedAt: Date;
}

async function loadRecentRejectionsByTool(
  tx: DbTx,
  userId: string,
  pendingRows: Array<{ staging: typeof actionStagings.$inferSelect }>,
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

function serializeActionStaging(
  s: typeof actionStagings.$inferSelect,
  workflowSlug: string,
  recentRejection: RecentRejection | null,
): Record<string, unknown> {
  return {
    id: s.id,
    userId: s.userId,
    runId: s.runId,
    workflowSlug,
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
          decidedAt: toIso(recentRejection.decidedAt),
        }
      : null,
    rowVersion: s.rowVersion,
    createdAt: toIso(s.createdAt),
    updatedAt: toIso(s.updatedAt),
  };
}
