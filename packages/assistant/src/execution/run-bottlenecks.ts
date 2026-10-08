/**
 * Where a run's time went, from Postgres alone, so it works without Langfuse (#409).
 * A gap between steps is classed by the step before it: after `interrupted` it is a wait,
 * after `deferred` a backoff, else queue time.
 * Sub-agent wait is the parked time that approvals do not explain; per-child timings are not
 * stored.
 */

import { db } from "@alfred/db";
import {
  actionStagings,
  agentRuns,
  agentSteps,
  apiCallLog,
  type AgentError,
} from "@alfred/db/schemas";
import { isParkedAgentStepStatus, isQuestionApproval } from "@alfred/contracts";
import { asc, eq } from "drizzle-orm";

const DISPATCH_TOOLS_STEP_ID = "dispatch-tools";

const LEASE_RECLAIMED_REASON = "lease_reclaimed";

export interface RunBottleneckApiCall {
  latencyMs: number | null;
  inputTokens: number | null;
  outputTokens: number | null;
  /** Postgres `numeric` arrives as a string. */
  costUsd: string | number | null;
}

export interface RunBottleneckStep {
  stepId: string;
  status: string;
  startedAt: Date;
  endedAt: Date | null;
  errorReason: string | null;
}

export interface RunBottleneckStaging {
  toolName: string;
  status: string;
  createdAt: Date;
  decidedAt: Date | null;
}

export interface RunBottleneckInput {
  run: { startedAt: Date | null; endedAt: Date | null };
  apiCalls: readonly RunBottleneckApiCall[];
  steps: readonly RunBottleneckStep[];
  stagings: readonly RunBottleneckStaging[];
}

export interface RunBottleneckSummary {
  /** Null until the run has started and ended. */
  wallClockMs: number | null;
  /** All metered calls, embeddings and tool APIs included. */
  modelMs: number;
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
  /** Wall time of whole `dispatch-tools` steps, not per tool. */
  toolMs: number;
  /** Gap time left after the waits: real queue time plus reclaim delay. */
  queueMs: number;
  deferredWaitMs: number;
  approvalWaitMs: number;
  subAgentWaitMs: number;
  reclaims: number;
  stagingsRejected: number;
  stagingsExpired: number;
}

/** Pure: no DB and no clock. Sorts steps itself. */
export function summarizeRunBottlenecks(input: RunBottleneckInput): RunBottleneckSummary {
  const wallClockMs =
    input.run.startedAt && input.run.endedAt
      ? nonNegativeMs(input.run.startedAt, input.run.endedAt)
      : null;

  let modelMs = 0;
  let inputTokens = 0;
  let outputTokens = 0;
  let costUsd = 0;

  for (const call of input.apiCalls) {
    if (call.latencyMs != null) modelMs += call.latencyMs;

    if (call.inputTokens != null) inputTokens += call.inputTokens;

    if (call.outputTokens != null) outputTokens += call.outputTokens;
    costUsd += toNumber(call.costUsd);
  }

  const steps = [...input.steps].sort((a, b) => a.startedAt.getTime() - b.startedAt.getTime());

  let toolMs = 0;
  let reclaims = 0;

  for (const step of steps) {
    // A reclaimed step's `ended_at` is a reclaim stamp, not tool work.
    if (
      step.stepId === DISPATCH_TOOLS_STEP_ID &&
      step.endedAt &&
      (step.status === "completed" || step.status === "interrupted")
    ) {
      toolMs += nonNegativeMs(step.startedAt, step.endedAt);
    }

    if (step.status === "failed" && step.errorReason === LEASE_RECLAIMED_REASON) reclaims += 1;
  }

  let totalGapMs = 0;
  let waitGapMs = 0;
  let deferredWaitMs = 0;

  for (let i = 1; i < steps.length; i++) {
    const prev = steps[i - 1];
    const cur = steps[i];

    if (!prev?.endedAt || !cur) continue;
    const gap = nonNegativeMs(prev.endedAt, cur.startedAt);
    totalGapMs += gap;

    if (isParkedAgentStepStatus(prev.status)) {
      if (prev.status === "deferred") deferredWaitMs += gap;
      else waitGapMs += gap;
    }
  }

  let approvalWaitMs = 0;
  let stagingsRejected = 0;
  let stagingsExpired = 0;

  for (const staging of input.stagings) {
    if (staging.decidedAt) approvalWaitMs += nonNegativeMs(staging.createdAt, staging.decidedAt);

    // A dismissed question is not a rejected write (ADR-0099). Its wait counts; its status does
    // not.
    if (isQuestionApproval(staging.toolName)) continue;

    if (staging.status === "rejected") stagingsRejected += 1;

    if (staging.status === "expired") stagingsExpired += 1;
  }

  // Clamp: an approval can outlive its step's gap.
  const subAgentWaitMs = Math.max(0, waitGapMs - approvalWaitMs);

  const queueMs = Math.max(0, totalGapMs - approvalWaitMs - subAgentWaitMs - deferredWaitMs);

  return {
    wallClockMs,
    modelMs,
    inputTokens,
    outputTokens,
    costUsd,
    toolMs,
    queueMs,
    deferredWaitMs,
    approvalWaitMs,
    subAgentWaitMs,
    reclaims,
    stagingsRejected,
    stagingsExpired,
  };
}

/** Null when the run does not exist. */
export async function getRunBottleneckSummary(runId: string): Promise<RunBottleneckSummary | null> {
  const [runRows, apiCalls, stepRows, stagings] = await Promise.all([
    db()
      .select({ startedAt: agentRuns.startedAt, endedAt: agentRuns.endedAt })
      .from(agentRuns)
      .where(eq(agentRuns.id, runId))
      .limit(1),
    db()
      .select({
        latencyMs: apiCallLog.latencyMs,
        inputTokens: apiCallLog.inputTokens,
        outputTokens: apiCallLog.outputTokens,
        costUsd: apiCallLog.costUsd,
      })
      .from(apiCallLog)
      .where(eq(apiCallLog.runId, runId)),
    db()
      .select({
        stepId: agentSteps.stepId,
        status: agentSteps.status,
        startedAt: agentSteps.startedAt,
        endedAt: agentSteps.endedAt,
        error: agentSteps.error,
      })
      .from(agentSteps)
      .where(eq(agentSteps.runId, runId))
      .orderBy(asc(agentSteps.id)),
    db()
      .select({
        toolName: actionStagings.toolName,
        status: actionStagings.status,
        createdAt: actionStagings.createdAt,
        decidedAt: actionStagings.decidedAt,
      })
      .from(actionStagings)
      .where(eq(actionStagings.runId, runId)),
  ]);

  const run = runRows[0];

  if (!run) return null;

  return summarizeRunBottlenecks({
    run,
    apiCalls,
    steps: stepRows.map((s) => ({
      stepId: s.stepId,
      status: s.status,
      startedAt: s.startedAt,
      endedAt: s.endedAt,
      errorReason: extractErrorReason(s.error),
    })),
    stagings,
  });
}

/** Clamped at 0 against clock skew. */
function nonNegativeMs(startedAt: Date, endedAt: Date): number {
  return Math.max(0, endedAt.getTime() - startedAt.getTime());
}

function toNumber(value: string | number | null): number {
  if (value == null) return 0;
  const n = typeof value === "number" ? value : Number(value);

  return Number.isFinite(n) ? n : 0;
}

function extractErrorReason(error: AgentError | null): string | null {
  return error?.reason ?? null;
}
