import {
  actionStagingStatusSchema,
  canonicalJson,
  effectOutcomeSchema,
  isToolRiskTier,
  isWriteRiskTier,
  workflowReadinessOutputSchema,
  type EffectReceipt,
  type WorkflowRecoveryAction,
  type WorkflowRunOutcome,
} from "@alfred/contracts";
import type { DbTransaction } from "@alfred/db";
import { actionStagings, workflows, type ActionStaging, type AgentRun } from "@alfred/db/schemas";
import { emitReplicachePokes } from "@alfred/assistant/triggers";
import { and, asc, eq, sql } from "drizzle-orm";
import { isInternalWorkflowSlug, type RunDeferReason } from "./registry";

// The typed outcome stored with every terminal or deferred status write (#561).

export type RunOutcomeSubject = Pick<AgentRun, "id" | "userId" | "workflowSlug">;

/** A blocked run's `output` is the `check-readiness` contract, parsed with its schema. */
export type RunOutcomeWrite =
  | { status: "completed"; summary: string | undefined }
  | { status: "blocked"; output: unknown }
  | {
      status: "failed";
      code: "step_failed" | "workflow_unresolved" | "non_progressing";
      safeMessage: string;
    }
  | { status: "cancelled" }
  | { status: "deferred"; reason: RunDeferReason | undefined; retryAt: Date };

/** `$type<>()` enums are casts over `text`, so `toEffectReceipt` narrows each again. */
export type EffectReceiptSource = Pick<ActionStaging, keyof typeof effectReceiptColumns>;

/** Keeps one jsonb row bounded. */
export const EFFECT_RECEIPT_CAP = 50;

const STAGING_READ_CAP = 500;

const SUMMARY_MAX_CHARS = 280;

/**
 * Unknown values never read as success: a bad tier is `high`, a bad outcome `unknown`, a bad status
 * `failed`.
 */
export function toEffectReceipt(row: EffectReceiptSource): EffectReceipt {
  const outcome = effectOutcomeSchema.safeParse(row.outcome);
  const status = actionStagingStatusSchema.safeParse(row.status);

  return {
    effectKey: row.effectKey,
    toolName: row.toolName,
    integration: row.integration,
    riskTier: isToolRiskTier(row.riskTier) ? row.riskTier : "high",
    outcome: outcome.success ? outcome.data : "unknown",
    status: status.success ? status.data : "failed",
    providerRef: row.providerRef,
    executedAt: row.executedAt?.toISOString() ?? null,
  };
}

export const effectReceiptColumns = {
  effectKey: actionStagings.effectKey,
  toolName: actionStagings.toolName,
  integration: actionStagings.integration,
  riskTier: actionStagings.riskTier,
  outcome: actionStagings.outcome,
  status: actionStagings.status,
  providerRef: actionStagings.providerRef,
  executedAt: actionStagings.executedAt,
} as const;

/** Only write tiers are receipts. */
async function readWriteReceipts(tx: DbTransaction, runId: string): Promise<EffectReceipt[]> {
  const rows = await tx
    .select(effectReceiptColumns)
    .from(actionStagings)
    .where(eq(actionStagings.runId, runId))
    .orderBy(asc(actionStagings.createdAt), asc(actionStagings.id))
    .limit(STAGING_READ_CAP);

  return rows.filter((row) => isWriteRiskTier(row.riskTier)).map(toEffectReceipt);
}

function clipSummary(summary: string | undefined): string {
  const trimmed = summary?.trim() ?? "";

  if (!trimmed) return "Run completed.";

  return trimmed.length <= SUMMARY_MAX_CHARS ? trimmed : `${trimmed.slice(0, SUMMARY_MAX_CHARS)}…`;
}

function distinctRecoveryActions(
  actions: readonly (WorkflowRecoveryAction | undefined)[],
): WorkflowRecoveryAction[] {
  const seen = new Set<string>();
  const out: WorkflowRecoveryAction[] = [];

  for (const action of actions) {
    if (!action) continue;
    const key = canonicalJson(action);

    if (seen.has(key)) continue;
    seen.add(key);
    out.push(action);
  }

  return out;
}

/**
 * Null for internal runs (chat turns, sub-agents). Call it before the guarded update and pass the
 * result to the same `.set()`.
 */
export async function deriveRunOutcome(
  tx: DbTransaction,
  run: RunOutcomeSubject,
  write: RunOutcomeWrite,
): Promise<WorkflowRunOutcome | null> {
  if (isInternalWorkflowSlug(run.workflowSlug)) return null;

  if (write.status === "deferred") {
    return {
      kind: "deferred",
      code: write.reason ?? "retry_scheduled",
      retryAt: write.retryAt.toISOString(),
    };
  }

  const receipts = await readWriteReceipts(tx, run.id);
  const unknown = receipts.filter((r) => r.outcome === "unknown");

  if (write.status === "cancelled") {
    return {
      kind: "cancelled",
      completedEffects: receipts
        .filter((r) => r.outcome === "succeeded")
        .slice(0, EFFECT_RECEIPT_CAP),
      unknownEffects: unknown.map((r) => r.effectKey),
    };
  }

  // An unobserved write wins: a retry could duplicate it, so the run must not look retryable.
  const firstUnknown = unknown[0];

  if (firstUnknown) {
    return { kind: "unknown_write_outcome", effectKey: firstUnknown.effectKey, safeToRetry: false };
  }

  if (write.status === "completed") {
    const succeeded = receipts.filter((r) => r.outcome === "succeeded");
    const summary = clipSummary(write.summary);

    if (succeeded.length === 0) return { kind: "no_change", summary };

    return { kind: "completed", summary, effects: succeeded.slice(0, EFFECT_RECEIPT_CAP) };
  }

  if (write.status === "blocked") {
    const parsed = workflowReadinessOutputSchema.safeParse(write.output);
    const problems = parsed.success ? parsed.data.readiness : [];

    return {
      kind: "blocked",
      code: problems[0]?.code ?? "blocked",
      recovery: distinctRecoveryActions(problems.map((p) => p.recoveryAction)),
    };
  }

  return { kind: "failed", code: write.code, safeMessage: write.safeMessage };
}

/**
 * Call after the guarded update in the same tx, so a superseded commit rolls it back. Not for
 * `deferred`.
 */
export async function recordWorkflowLastRun(
  tx: DbTransaction,
  run: RunOutcomeSubject,
  status: "completed" | "blocked" | "failed" | "cancelled",
  now: Date,
): Promise<void> {
  if (isInternalWorkflowSlug(run.workflowSlug)) return;
  await tx
    .update(workflows)
    .set({
      lastRunId: run.id,
      lastRunAt: now,
      lastRunStatus: status,
      rowVersion: sql`${workflows.rowVersion} + 1`,
      updatedAt: now,
    })
    .where(and(eq(workflows.userId, run.userId), eq(workflows.slug, run.workflowSlug)));
}

/** Call after commit. The History tab refetches when the synced `lastRunAt` moves. */
export function pokeWorkflowOwner(run: RunOutcomeSubject): void {
  if (isInternalWorkflowSlug(run.workflowSlug)) return;
  emitReplicachePokes([run.userId]);
}
