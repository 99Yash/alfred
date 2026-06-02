import {
  actionStagings,
  agentRuns,
  briefings,
  notes,
  skillRevisions,
  skillRuns,
  skills,
  userActionPolicies,
  userFacts,
  userPreferences,
  workflows,
  type AgentRunTrigger,
} from "@alfred/db/schemas";
import {
  IDB_KEY_NAMES,
  jsonRecordSchema,
  memorySourceSchema,
  syncedActionPolicySchema,
  syncedActionStagingSchema,
  syncedBriefingSchema,
  syncedFactSchema,
  syncedNoteSchema,
  syncedPreferenceSchema,
  syncedSkillRevisionSchema,
  syncedSkillRunSchema,
  syncedSkillSchema,
  syncedWorkflowSchema,
  type IDBKeys,
  type SyncedActionPolicy,
  type SyncedActionStaging,
  type SyncedBriefing,
  type SyncedEntity,
  type SyncedFact,
  type SyncedNote,
  type SyncedPreference,
  type SyncedSkill,
  type SyncedSkillRevision,
  type SyncedSkillRun,
  type SyncedWorkflow,
} from "@alfred/sync";
import { and, asc, desc, eq, gte, inArray, isNotNull } from "drizzle-orm";
import { ZodError } from "zod";

/**
 * One row's contribution to the patch: its row_version drives CVR diffing,
 * and `serialized` is the value Replicache writes to the client store.
 */
export interface EntityRow {
  id: string;
  rowVersion: number;
  serialized: SyncedEntity;
}

// Typed loosely so this accepts either the pool or a Drizzle tx handle.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type DbTx = any;

type EntityFetcher = (tx: DbTx, userId: string) => Promise<EntityRow[]>;

const RECENT_REJECTION_WINDOW_MS = 14 * 24 * 60 * 60 * 1000;
const BRIEFING_PULL_WINDOW_DAYS = 30;

function toEntityRow(args: {
  slug: IDBKeys;
  id: string;
  rowVersion: number;
  serialize: () => SyncedEntity;
}): EntityRow[] {
  try {
    return [
      {
        id: args.id,
        rowVersion: args.rowVersion,
        serialized: args.serialize(),
      },
    ];
  } catch (err) {
    if (!isRecoverableSerializationError(err)) throw err;
    const message = err instanceof Error ? err.message : String(err);
    console.warn(`[replicache] skipping invalid ${args.slug} row '${args.id}': ${message}`);
    return [];
  }
}

function isRecoverableSerializationError(err: unknown): boolean {
  return (
    err instanceof ZodError || (err instanceof Error && err.message.startsWith("[replicache]"))
  );
}

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
    return rows.flatMap((n: typeof notes.$inferSelect) =>
      toEntityRow({
        slug: "NOTE",
        id: n.id,
        rowVersion: n.rowVersion,
        serialize: () => serializeNote(n),
      }),
    );
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
    return rows.flatMap((f: typeof userFacts.$inferSelect) =>
      toEntityRow({
        slug: "FACT",
        id: f.id,
        rowVersion: f.rowVersion,
        serialize: () => serializeFact(f),
      }),
    );
  },

  BRIEFING: async (tx, userId) => {
    const cutoff = new Date();
    cutoff.setUTCDate(cutoff.getUTCDate() - BRIEFING_PULL_WINDOW_DAYS);
    const cutoffDate = cutoff.toISOString().slice(0, 10);
    const rows = await tx
      .select()
      .from(briefings)
      .where(and(eq(briefings.userId, userId), gte(briefings.briefingDate, cutoffDate)))
      .orderBy(desc(briefings.briefingDate), asc(briefings.slot));
    return rows.flatMap((b: typeof briefings.$inferSelect) =>
      toEntityRow({
        slug: "BRIEFING",
        id: `${b.briefingDate}/${b.slot}`,
        rowVersion: b.rowVersion,
        serialize: () => serializeBriefing(b),
      }),
    );
  },

  // Preferences are keyed by `(user_id, key)`; the IDB id is the pref key
  // so optimistic client writes can address rows without a lookup.
  PREFERENCE: async (tx, userId) => {
    const rows = await tx
      .select()
      .from(userPreferences)
      .where(eq(userPreferences.userId, userId))
      .orderBy(asc(userPreferences.key));
    return rows.flatMap((p: typeof userPreferences.$inferSelect) =>
      toEntityRow({
        slug: "PREFERENCE",
        id: p.key,
        rowVersion: p.rowVersion,
        serialize: () => serializePreference(p),
      }),
    );
  },

  SKILL: async (tx, userId) => {
    const rows = await tx
      .select()
      .from(skills)
      .where(eq(skills.userId, userId))
      .orderBy(asc(skills.id));
    return rows.flatMap((s: typeof skills.$inferSelect) =>
      toEntityRow({
        slug: "SKILL",
        id: s.id,
        rowVersion: s.rowVersion,
        serialize: () => serializeSkill(s),
      }),
    );
  },

  SKILL_REVISION: async (tx, userId) => {
    const rows = await tx
      .select()
      .from(skillRevisions)
      .where(eq(skillRevisions.userId, userId))
      .orderBy(asc(skillRevisions.id));
    return rows.flatMap((r: typeof skillRevisions.$inferSelect) =>
      toEntityRow({
        slug: "SKILL_REVISION",
        id: r.id,
        rowVersion: r.rowVersion,
        serialize: () => serializeSkillRevision(r),
      }),
    );
  },

  SKILL_RUN: async (tx, userId) => {
    const rows = await tx
      .select()
      .from(skillRuns)
      .where(eq(skillRuns.userId, userId))
      .orderBy(asc(skillRuns.id));
    return rows.flatMap((r: typeof skillRuns.$inferSelect) =>
      toEntityRow({
        slug: "SKILL_RUN",
        id: r.id,
        rowVersion: r.rowVersion,
        serialize: () => serializeSkillRun(r),
      }),
    );
  },

  // The approvals surface only syncs rows that still require a user
  // decision. Autonomy rows may briefly be `pending` while the dispatcher
  // is executing the tool; those are audit rows, not approval cards.
  ACTION_STAGING: async (tx, userId) => {
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
        staging: typeof actionStagings.$inferSelect;
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
  },

  // The per-integration policy editor (m13 Phase 8c). One row per user,
  // synced as a single entity keyed by `userId`; the web derives each
  // integration's mode from `integration_rules[slug] ?? default_mode`.
  ACTION_POLICY: async (tx, userId) => {
    const rows = await tx
      .select()
      .from(userActionPolicies)
      .where(eq(userActionPolicies.userId, userId));
    return rows.flatMap((p: typeof userActionPolicies.$inferSelect) =>
      toEntityRow({
        slug: "ACTION_POLICY",
        id: p.userId,
        rowVersion: p.rowVersion,
        serialize: () => serializeActionPolicy(p),
      }),
    );
  },

  // Both built-in and user-authored rows sync (m13 Phase 8). The editor
  // only mutates `is_builtin = false` rows; built-ins render read-only.
  // Keyed by `slug` so the editor's optimistic write addresses the row
  // without an id lookup, matching the `/workflows/$workflow` route param.
  WORKFLOW: async (tx, userId) => {
    const rows = await tx
      .select()
      .from(workflows)
      .where(eq(workflows.userId, userId))
      .orderBy(asc(workflows.slug));
    return rows.flatMap((w: typeof workflows.$inferSelect) =>
      toEntityRow({
        slug: "WORKFLOW",
        id: w.slug,
        rowVersion: w.rowVersion,
        serialize: () => serializeWorkflow(w),
      }),
    );
  },
} satisfies Record<IDBKeys, EntityFetcher>;

export const SYNC_ENTITIES = IDB_KEY_NAMES.map((slug) => ({
  slug,
  fetchRows: ENTITY_FETCHERS[slug],
}));

const toIso = (d: Date | null | undefined): string | null =>
  d instanceof Date ? d.toISOString() : (d ?? null);

function toRequiredIso(d: Date | null | undefined, field: string): string {
  const value = toIso(d);
  if (value === null) throw new Error(`[replicache] ${field} must not be null`);
  return value;
}

function serializeNote(n: {
  id: string;
  userId: string;
  text: string;
  rowVersion: number;
  createdAt: Date;
}): SyncedNote {
  return syncedNoteSchema.parse({
    id: n.id,
    userId: n.userId,
    text: n.text,
    createdAt: toRequiredIso(n.createdAt, "notes.createdAt"),
    rowVersion: n.rowVersion,
  });
}

function serializeFact(f: typeof userFacts.$inferSelect): SyncedFact {
  if (f.status !== "proposed" && f.status !== "confirmed") {
    throw new Error(`[replicache] cannot sync fact with status '${f.status}'`);
  }
  return syncedFactSchema.parse({
    id: f.id,
    userId: f.userId,
    key: f.key,
    value: f.value,
    confidence: f.confidence,
    status: f.status,
    source: memorySourceSchema.parse(f.source),
    validFrom: toRequiredIso(f.validFrom, "userFacts.validFrom"),
    validUntil: toIso(f.validUntil),
    supersedesId: f.supersedesId,
    rowVersion: f.rowVersion,
    createdAt: toRequiredIso(f.createdAt, "userFacts.createdAt"),
    updatedAt: toIso(f.updatedAt),
  });
}

function serializeBriefing(b: typeof briefings.$inferSelect): SyncedBriefing {
  return syncedBriefingSchema.parse({
    id: b.id,
    userId: b.userId,
    briefingDate: b.briefingDate,
    slot: b.slot,
    timezone: b.timezone,
    status: b.status,
    sendDecision: b.sendDecision ?? null,
    gateReason: b.gateReason,
    gather: b.gather ?? null,
    breakingSummary: b.breakingSummary,
    fullBriefing: b.fullBriefing ?? null,
    model: b.model,
    composeFallback: b.composeFallback,
    emailSendId: b.emailSendId,
    rowVersion: b.rowVersion,
    createdAt: toRequiredIso(b.createdAt, "briefings.createdAt"),
    updatedAt: toIso(b.updatedAt),
  });
}

function serializePreference(p: typeof userPreferences.$inferSelect): SyncedPreference {
  return syncedPreferenceSchema.parse({
    key: p.key,
    userId: p.userId,
    value: p.value,
    source: memorySourceSchema.parse(p.source),
    rowVersion: p.rowVersion,
  });
}

function serializeActionPolicy(p: typeof userActionPolicies.$inferSelect): SyncedActionPolicy {
  return syncedActionPolicySchema.parse({
    userId: p.userId,
    defaultMode: p.defaultMode,
    integrationRules: p.integrationRules,
    approvalNotifyDelayMs: p.approvalNotifyDelayMs,
    rowVersion: p.rowVersion,
  });
}

function serializeWorkflow(w: typeof workflows.$inferSelect): SyncedWorkflow {
  return syncedWorkflowSchema.parse({
    id: w.id,
    userId: w.userId,
    slug: w.slug,
    name: w.name,
    description: w.description,
    trigger: w.trigger,
    brief: w.brief,
    allowedIntegrations: w.allowedIntegrations,
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

function serializeSkill(s: typeof skills.$inferSelect): SyncedSkill {
  return syncedSkillSchema.parse({
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
    createdAt: toRequiredIso(s.createdAt, "skills.createdAt"),
    updatedAt: toIso(s.updatedAt),
  });
}

function serializeSkillRevision(r: typeof skillRevisions.$inferSelect): SyncedSkillRevision {
  return syncedSkillRevisionSchema.parse({
    id: r.id,
    skillId: r.skillId,
    userId: r.userId,
    kind: r.kind,
    body: r.body,
    metadata: jsonRecordSchema.parse(r.metadata),
    createdByRunId: r.createdByRunId,
    rowVersion: r.rowVersion,
    createdAt: toRequiredIso(r.createdAt, "skillRevisions.createdAt"),
  });
}

function serializeSkillRun(r: typeof skillRuns.$inferSelect): SyncedSkillRun {
  return syncedSkillRunSchema.parse({
    id: r.id,
    skillId: r.skillId,
    userId: r.userId,
    kind: r.kind,
    agentRunId: r.agentRunId,
    status: r.status,
    producedRevisionId: r.producedRevisionId,
    rowVersion: r.rowVersion,
    startedAt: toRequiredIso(r.startedAt, "skillRuns.startedAt"),
    endedAt: toIso(r.endedAt),
  });
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

/** Brief preview cap on the synced card row — full text stays server-side. */
const BRIEF_PREVIEW_CHARS = 280;

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
  s: typeof actionStagings.$inferSelect,
  provenance: {
    workflowSlug: string;
    workflowName: string | null;
    trigger: AgentRunTrigger | null;
    brief: string | null;
    recentRejection: RecentRejection | null;
  },
): SyncedActionStaging {
  if (s.status !== "pending") {
    throw new Error(`[replicache] cannot sync action staging with status '${s.status}'`);
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
