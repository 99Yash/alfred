import {
  actionStagingStatusSchema,
  canonicalJson,
  effectOutcomeSchema,
  getStringPath,
  isToolRiskTier,
  workflowReadinessOutputSchema,
  type EffectReceipt,
  type WorkflowRecoveryAction,
  type WorkflowRunOutcome,
} from "@alfred/contracts";
import type { DbTransaction } from "@alfred/db";
import { actionStagings, workflows, type ActionStaging, type AgentRun } from "@alfred/db/schemas";
import { emitReplicachePokes } from "@alfred/assistant/triggers";
import { and, asc, eq, sql } from "drizzle-orm";
import { isInternalWorkflowSlug } from "./registry";

/**
 * The typed verdict every terminal (and deferred) run write carries beside its
 * status (#561). One module owns the derivation so the seven write sites —
 * `done`, `blocked`, `defer`, step failure, resolve failure, the lease backstop
 * and cancel — agree on what "something happened" means, and the history
 * reader never re-derives it from `status` + `error`.
 */

/** The run columns the derivation and the workflow roll-up need. */
export type RunOutcomeSubject = Pick<AgentRun, "id" | "userId" | "workflowSlug">;

/** Which terminal write is about to land, with the inputs its kind needs. */
export type RunOutcomeWrite =
  | { status: "completed"; output: unknown }
  | { status: "blocked"; output: unknown }
  | {
      status: "failed";
      code: "step_failed" | "workflow_unresolved" | "non_progressing";
      safeMessage: string;
    }
  | { status: "cancelled" }
  | { status: "deferred"; output: unknown; retryAt: Date };

/** The staging columns an effect receipt is projected from. */
export type EffectReceiptSource = Pick<
  ActionStaging,
  "effectKey" | "toolName" | "integration" | "providerRef" | "executedAt"
> & {
  /** Persisted enums arrive as `text`; the projection re-narrows each one. */
  riskTier: string;
  outcome: string;
  status: string;
};

/** Receipts and outcome effect lists are capped so one jsonb row stays bounded. */
export const EFFECT_RECEIPT_CAP = 50;
const STAGING_READ_CAP = 500;
const SUMMARY_MAX_CHARS = 280;

/** Reads never count as effects: only a tier that can change external state does. */
export function isWriteRiskTier(riskTier: string): boolean {
  return riskTier !== "no_risk";
}

/**
 * Project one persisted staging into a receipt. Out-of-enum tiers fall to the
 * conservative `high`; unrecognized outcome/status values read as
 * `unknown`/`failed`, never as a success.
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

/** Select list shared by the in-tx derivation and the history reader. */
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

// Typed loosely so the cancel path (whose own tx is `any`) can share it.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type OutcomeTx = DbTransaction | any;

async function readWriteReceipts(tx: OutcomeTx, runId: string): Promise<EffectReceipt[]> {
  const rows: EffectReceiptSource[] = await tx
    .select(effectReceiptColumns)
    .from(actionStagings)
    .where(eq(actionStagings.runId, runId))
    .orderBy(asc(actionStagings.createdAt), asc(actionStagings.id))
    .limit(STAGING_READ_CAP);
  return rows.filter((row) => isWriteRiskTier(row.riskTier)).map(toEffectReceipt);
}

function clipSummary(text: string): string {
  const trimmed = text.trim();
  return trimmed.length <= SUMMARY_MAX_CHARS ? trimmed : `${trimmed.slice(0, SUMMARY_MAX_CHARS)}…`;
}

/** One sentence from a `done` step's output; the shapes come from the brief workflow. */
function summarizeOutput(output: unknown): string {
  if (typeof output === "string" && output.trim()) return clipSummary(output);
  const text = getStringPath(output, "text");
  if (text && text.trim()) return clipSummary(text);
  const stopped = getStringPath(output, "stoppedReason");
  if (stopped && stopped.trim()) return `Stopped: ${clipSummary(stopped)}`;
  return "Run completed.";
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
 * Derive the outcome for the write about to land. Returns null for internal
 * runs (chat turns, sub-agents), which carry no outcome so the jsonb stays off
 * every chat turn. Call it BEFORE the guarded status update so the outcome
 * rides in the same `.set()`; the read is harmless if the guard then refuses.
 */
export async function deriveRunOutcome(
  tx: OutcomeTx,
  run: RunOutcomeSubject,
  write: RunOutcomeWrite,
): Promise<WorkflowRunOutcome | null> {
  if (isInternalWorkflowSlug(run.workflowSlug)) return null;

  if (write.status === "deferred") {
    return {
      kind: "deferred",
      code: getStringPath(write.output, "reason") ? "provider_unhealthy" : "retry_scheduled",
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

  // A write whose result was never observed outranks every other verdict: a
  // retry could duplicate it, so the run must not read as done, blocked, or
  // retryable.
  const firstUnknown = unknown[0];
  if (firstUnknown) {
    return { kind: "unknown_write_outcome", effectKey: firstUnknown.effectKey, safeToRetry: false };
  }

  if (write.status === "completed") {
    const succeeded = receipts.filter((r) => r.outcome === "succeeded");
    const summary = summarizeOutput(write.output);
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
 * Roll the terminal status up onto the owning `workflows` row so the synced
 * workflow list shows the last run without a join. Call it AFTER the guarded
 * run update, on the same transaction, so a superseded commit rolls it back
 * too. Never for `deferred`: the run is not over.
 */
export async function recordWorkflowLastRun(
  tx: OutcomeTx,
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

/**
 * Wake the owner's Replicache clients after a terminal commit so the workflow
 * list and the history tab refresh. Internal runs have no workflow row to
 * refresh, so they stay silent. Call it after the transaction commits.
 */
export function pokeWorkflowOwner(run: RunOutcomeSubject): void {
  if (isInternalWorkflowSlug(run.workflowSlug)) return;
  emitReplicachePokes([run.userId]);
}
