/**
 * Run bottleneck summary (#409, PRD #405).
 *
 * Langfuse spans now cover the execution spine (LLM generations, tool spans),
 * orchestration overhead (`runtime.dispatch.batch`, `runtime.scratch.*`), and
 * the wait/queue wall-clock this slice added (`runtime.approval.wait`,
 * `runtime.sub_agent.wait`, `runtime.queue.lease`). This module answers the
 * operator's blunt question — *"where did this run's time go?"* — from the
 * queryable Postgres tables alone, so it works without a Langfuse account and
 * can back a future internal debug route.
 *
 * Split into a pure aggregator (`summarizeRunBottlenecks`) over already-fetched
 * rows plus a thin DB wrapper (`getRunBottleneckSummary`), so tests feed
 * synthetic rows with known durations and never touch a live DB.
 *
 * Honesty of the buckets (PRD "runtime observations OR queryable metadata"):
 *  - `modelMs`/tokens/cost come straight from `api_call_log`.
 *  - `toolMs` is the wall time of `dispatch-tools` steps — dispatch-batch wall
 *    time, NOT per-tool timings (those live only in Langfuse spans, #406). It
 *    therefore includes the batch's own orchestration overhead by design.
 *  - Scratchpad time is Langfuse-only (#408) and is deliberately omitted here.
 *  - A gap between consecutive steps is classified by the *preceding* step's
 *    status: a gap after a parked (`interrupted`) step is a wait; a gap after a
 *    step that ran to a non-parked terminal (`completed`/`failed`) is
 *    time-in-queue. `approvalWaitMs` is summed precisely from `action_stagings`
 *    (`decided_at − created_at`); `subAgentWaitMs` is the parked wall-clock not
 *    explained by approvals (`await_sub_agent`/signal joins), the only
 *    Postgres-derivable attribution since per-child timings aren't stored here.
 *    `queueMs` is the remaining inter-step gap after subtracting both waits:
 *    genuine time-in-queue plus stale-lease reclaim delay.
 */

import { db } from "@alfred/db";
import { actionStagings, agentRuns, agentSteps, apiCallLog } from "@alfred/db/schemas";
import { asc, eq } from "drizzle-orm";

/**
 * The dispatch step whose wall time is attributed to `toolMs`. Kept local (not
 * imported from `./runtime-spans`) so this queryable summary does not depend on
 * the tracing module.
 */
const DISPATCH_TOOLS_STEP_ID = "dispatch-tools";

/** Structured `error->>'reason'` marker a stale-lease reclaim writes (executor). */
const LEASE_RECLAIMED_REASON = "lease_reclaimed";

/** One metered external call, as fed to the pure aggregator. */
export interface RunBottleneckApiCall {
  latencyMs: number | null;
  inputTokens: number | null;
  outputTokens: number | null;
  /** `numeric` from Postgres arrives as a string; accept either. */
  costUsd: string | number | null;
}

/** One `agent_steps` row, as fed to the pure aggregator. */
export interface RunBottleneckStep {
  stepId: string;
  status: string;
  startedAt: Date;
  endedAt: Date | null;
  /** Extracted from `agent_steps.error->>'reason'`; null when absent. */
  errorReason: string | null;
}

/** One `action_stagings` row, as fed to the pure aggregator. */
export interface RunBottleneckStaging {
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
  /** Total run wall-clock; null until the run has both started and ended. */
  wallClockMs: number | null;
  /** Summed `latency_ms` across metered calls (model + embedding + tool APIs). */
  modelMs: number;
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
  /** Wall time of `dispatch-tools` steps (dispatch-batch wall time, not per-tool). */
  toolMs: number;
  /** Inter-step wall-clock left after subtracting approval + sub-agent waits. */
  queueMs: number;
  /** Summed `decided_at − created_at` over stagings. */
  approvalWaitMs: number;
  /** Inter-step gaps following a non-approval `interrupted` step (join waits). */
  subAgentWaitMs: number;
  /** Count of steps failed with the `lease_reclaimed` reason. */
  reclaims: number;
  stagingsRejected: number;
  stagingsExpired: number;
}

/**
 * Fold the four queryable row sets of one run into its time buckets. Pure — no
 * DB, no clock — so a test controls every duration. Steps are sorted by their
 * start so the gap math is independent of the caller's ordering.
 */
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
    // A reclaimed/failed dispatch step's `ended_at` is a synthetic reclaim
    // stamp, not tool work — only count steps that ran (completed) or parked.
    if (
      step.stepId === DISPATCH_TOOLS_STEP_ID &&
      step.endedAt &&
      (step.status === "completed" || step.status === "interrupted")
    ) {
      toolMs += nonNegativeMs(step.startedAt, step.endedAt);
    }
    if (step.status === "failed" && step.errorReason === LEASE_RECLAIMED_REASON) reclaims += 1;
  }

  // Classify each inter-step gap by the preceding step's status: a gap after a
  // parked (`interrupted`) step is a wait (approval or join); a gap after a
  // non-parked terminal is pure time-in-queue.
  let totalGapMs = 0;
  let waitGapMs = 0;
  for (let i = 1; i < steps.length; i++) {
    const prev = steps[i - 1];
    const cur = steps[i];
    if (!prev?.endedAt || !cur) continue;
    const gap = nonNegativeMs(prev.endedAt, cur.startedAt);
    totalGapMs += gap;
    if (prev.status === "interrupted") waitGapMs += gap;
  }

  let approvalWaitMs = 0;
  let stagingsRejected = 0;
  let stagingsExpired = 0;
  for (const staging of input.stagings) {
    if (staging.decidedAt) approvalWaitMs += nonNegativeMs(staging.createdAt, staging.decidedAt);
    if (staging.status === "rejected") stagingsRejected += 1;
    if (staging.status === "expired") stagingsExpired += 1;
  }

  // Sub-agent (and other signal) joins aren't individually queryable from these
  // tables, so attribute the parked wall-clock not explained by approvals to
  // them. Clamp against an approval staging that outlived its step's gap.
  const subAgentWaitMs = Math.max(0, waitGapMs - approvalWaitMs);

  // Queue time is the inter-step wall-clock left after the attributed waits —
  // genuine time-in-queue plus stale-lease reclaim delay, never model, tool,
  // approval, or sub-agent time.
  const queueMs = Math.max(0, totalGapMs - approvalWaitMs - subAgentWaitMs);

  return {
    wallClockMs,
    modelMs,
    inputTokens,
    outputTokens,
    costUsd,
    toolMs,
    queueMs,
    approvalWaitMs,
    subAgentWaitMs,
    reclaims,
    stagingsRejected,
    stagingsExpired,
  };
}

/**
 * Fetch the four row sets for `runId` and summarize them. Returns null when the
 * run row doesn't exist. Thin by design — all logic lives in the pure
 * aggregator above.
 */
export async function getRunBottleneckSummary(
  runId: string,
): Promise<RunBottleneckSummary | null> {
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

/** Non-negative elapsed ms between two instants (clamped against clock skew). */
function nonNegativeMs(startedAt: Date, endedAt: Date): number {
  return Math.max(0, endedAt.getTime() - startedAt.getTime());
}

/** Coerce a `numeric` string (or number) to a finite number; anything else → 0. */
function toNumber(value: string | number | null): number {
  if (value == null) return 0;
  const n = typeof value === "number" ? value : Number(value);
  return Number.isFinite(n) ? n : 0;
}

/**
 * Read the structured `reason` off an `agent_steps.error` jsonb value. The
 * column is untyped `unknown`, so narrow at this boundary rather than casting.
 */
function extractErrorReason(error: unknown): string | null {
  if (error && typeof error === "object" && "reason" in error) {
    const reason = (error as { reason: unknown }).reason;
    return typeof reason === "string" ? reason : null;
  }
  return null;
}
