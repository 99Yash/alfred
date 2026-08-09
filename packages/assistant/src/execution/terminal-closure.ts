import { toMessage } from "@alfred/contracts";
import { db } from "@alfred/db";
import { agentRuns } from "@alfred/db/schemas";
import { eq } from "drizzle-orm";
import { resolveWorkflowForRun } from "./resolve-workflow";
import type { TerminalOutcome } from "./types";

/**
 * Workflow-level closure for a run that reached a terminal state outside its
 * step body.
 *
 * Three transitions land here — the non-progressing-step backstop, a post-deploy
 * step-resolution failure, and a cancel — and all three share one obligation:
 * *a terminal run must not leave a client-facing artifact mid-flight.* Before
 * the #530/#531 review only the two failure paths drove closure, so a cancel
 * left the chat turn with nothing to end it: under the new terminal guard both
 * commits roll back, nothing emits `chat.message completed`, and the assistant
 * bubble streams forever (finding D2).
 *
 * The cancel renders differently from a failure — a deliberate stop must not
 * surface a retryable error — so `Workflow.closure.onTerminal` discriminates on
 * `ctx.outcome` and each workflow switches. One hook, not two optional ones: the
 * regression above was a workflow implementing the failure branch and not the
 * cancel branch, which a union makes a compile error. This module is the single
 * place that drives it, so the next terminal transition has one door to knock on.
 *
 * Its own module rather than part of `executor.ts` because `service.ts`
 * (`cancelRun`) has to drive it too, and `executor` already imports from
 * `service` — routing closure through either would be a cycle.
 */

/** The run fields closure needs. A `Pick` of the row, not a parallel shape. */
export interface TerminalClosureRun {
  id: string;
  userId: string;
  workflowSlug: string;
  state: unknown;
}

/**
 * Resolve the run's workflow, validate its last-committed state, and hand both
 * plus the transition to its declared closure.
 *
 * Best-effort by contract: the terminal DB write has already landed, so every
 * fault here (an unresolvable workflow after a deploy, state-schema drift, the
 * hook itself) is logged and swallowed. Callers must not depend on it having
 * succeeded, and it must never resurrect or re-fail the run.
 */
async function driveClosure(run: TerminalClosureRun, outcome: TerminalOutcome): Promise<void> {
  try {
    const { workflow } = await resolveWorkflowForRun({
      userId: run.userId,
      workflowSlug: run.workflowSlug,
    });
    // Checked before parsing so a workflow that owes no closure can't be
    // reported as a closure failure by drifted persisted state.
    if (workflow.closure.kind === "none") return;
    const state = workflow.stateSchema ? workflow.stateSchema.parse(run.state) : run.state;
    await workflow.closure.onTerminal({ runId: run.id, userId: run.userId, state, ...outcome });
  } catch (err) {
    console.warn(
      `[agent] terminal closure (${outcome.outcome}) for run ${run.id} (${run.workflowSlug}) failed:`,
      toMessage(err),
    );
  }
}

/** Drive closure for a run already `failed` in the DB. */
export async function finalizeFailedRun(run: TerminalClosureRun, error: string): Promise<void> {
  await driveClosure(run, { outcome: "failed", error });
}

/**
 * Drive closure for a run that was just cancelled. Re-reads
 * the row because the cancel paths hold only a run id (`cancelRun`) or a narrow
 * approval-scoped row (`cancelRunInTx`'s caller), and `state` has to be the
 * last-committed value — a mid-step cancel rolls the in-flight step back, so the
 * state the hook should render is whatever the previous step boundary persisted.
 *
 * Call this *after* the cancel transaction commits, never inside it: the hook
 * writes client-facing rows and publishes events, and a rolled-back cancel must
 * not leave a closed turn behind. Best-effort, like {@link finalizeFailedRun}:
 * a vanished run is a silent no-op.
 */
export async function finalizeCancelledRun(runId: string, reason: string): Promise<void> {
  try {
    const rows = await db()
      .select({
        id: agentRuns.id,
        userId: agentRuns.userId,
        workflowSlug: agentRuns.workflowSlug,
        state: agentRuns.state,
      })
      .from(agentRuns)
      .where(eq(agentRuns.id, runId))
      .limit(1);
    const run = rows[0];
    if (!run) return;
    await driveClosure(run, { outcome: "cancelled", reason });
  } catch (err) {
    console.warn(`[agent] cancel closure lookup for run ${runId} failed:`, toMessage(err));
  }
}
