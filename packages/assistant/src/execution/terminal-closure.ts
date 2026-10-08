import { toMessage } from "@alfred/contracts";
import { db } from "@alfred/db";
import { agentRuns } from "@alfred/db/schemas";
import { eq } from "drizzle-orm";
import { resolveWorkflowForRun } from "./resolve-workflow";

/** No `completed` case: a run completes inside a step body, which owns that closure. */
interface TerminalRunFields<S> {
  runId: string;
  userId: string;
  /** Last committed state, parsed by `stateSchema` if set. */
  state: S;
}

export type TerminalOutcome =
  | {
      outcome: "failed";
      /** Already sanitized and safe to show. */
      error: string;
    }
  | {
      outcome: "cancelled";
      reason: string;
    };

/**
 * One hook with a union, not two optional hooks, so a workflow that forgets the cancel case fails
 * to compile.
 * The distributed form lets `switch (ctx.outcome)` narrow `error` and `reason`.
 */
type TerminalClosureContext<S> =
  | (TerminalRunFields<S> & { outcome: "failed"; error: string })
  | (TerminalRunFields<S> & { outcome: "cancelled"; reason: string });

/** What a run that ends outside its step body owes the client. */
export type WorkflowClosure<S> =
  | {
      kind: "none";
    }
  | {
      kind: "client";
      onTerminal(ctx: TerminalClosureContext<S>): Promise<void>;
    };

// Closure for the backstop, an unresolved step, and a cancel: a terminal run must not
// leave a client artifact mid-flight. A separate module because both `executor` and `service` drive
// it.

export interface TerminalClosureRun {
  id: string;
  userId: string;
  workflowSlug: string;
  state: unknown;
}

/** Best-effort: the terminal write already landed, so every fault is logged and swallowed. */
async function driveClosure(run: TerminalClosureRun, outcome: TerminalOutcome): Promise<void> {
  try {
    const { workflow } = await resolveWorkflowForRun({
      userId: run.userId,
      workflowSlug: run.workflowSlug,
    });

    // Before parsing, so drifted state cannot fail a workflow that owes nothing.
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

export async function finalizeFailedRun(run: TerminalClosureRun, error: string): Promise<void> {
  await driveClosure(run, { outcome: "failed", error });
}

/**
 * Call after the cancel commits, so a rolled-back cancel leaves no closed turn.
 * Re-reads the row to get the last committed state.
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
