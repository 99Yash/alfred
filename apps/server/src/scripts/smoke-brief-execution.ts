/**
 * Smoke test for m13 Phase 4 — brief-only execution end-to-end.
 *
 *   $ pnpm --filter server tsx --env-file=.env src/scripts/smoke-brief-execution.ts
 *
 * Pre-reqs:
 *   - A server process running (`pnpm dev`) so the agent worker picks up
 *     the run. This script does not start a worker itself; it polls the
 *     run row and auto-approves any pending action_stagings inline,
 *     exercising both the autonomy and gated-resume dispatch paths.
 *   - At least one user with Google connected (gmail + calendar scopes).
 *     The smoke seeds activeIntegrations from `@gmail` in the brief and
 *     forces the boss to call `system.load_integration('calendar')`
 *     mid-run.
 *
 * What this verifies end-to-end (Phase 4 acceptance):
 *   1. createRun resolves the user-authored sentinel workflow without
 *      registering it, preserves the user-authored slug on the run row.
 *   2. boss-turn ↔ dispatch-tools ping-pong reaches `status='completed'`.
 *   3. `system.load_integration('calendar')` mid-run appends 'calendar'
 *      to `agent_runs.state.activeIntegrations` so subsequent boss
 *      turns see calendar tools in their toolset.
 *   4. action_stagings rows land for system.load_integration + the
 *      gmail/calendar tools the boss exercised, regardless of policy
 *      mode (system gets the autonomy override; non-system rides
 *      `user_action_policies`).
 *   5. One `api_call_log` row per `boss-turn` step (ADR-0026: one
 *      turn = one round-trip = one logged call).
 *   6. The run's final output carries a non-empty user-facing summary.
 *
 * What this does NOT verify:
 *   - Quality of the LLM summary (qualitative, requires human review).
 *   - Compaction (Phase 7, not yet built).
 *   - Sub-agent fan-out beyond what the boss happens to invoke
 *     (covered by smoke-sub-agents.ts at the plumbing level).
 */

import {
  closeAgentQueue,
  closeConnections,
  closeRedis,
  createRun,
  enqueueRun,
  signalRun,
  warmPool,
} from "@alfred/api";
import { toRecord } from "@alfred/contracts";
import { db } from "@alfred/db";
import {
  actionStagings,
  agentRuns,
  agentSteps,
  apiCallLog,
  integrationCredentials,
  user as userTable,
  userActionPolicies,
  workflows,
} from "@alfred/db/schemas";
import { and, eq, sql } from "drizzle-orm";
import { registerBuiltinWorkflows } from "../builtins";
import { POLL_INTERVAL_MS, POLL_TIMEOUT_MS, assert } from "./_smoke-helpers";

const WORKFLOW_SLUG = "smoke-brief-execution";
const SMOKE_BRIEF =
  "@gmail — Read my most recent inbox email and summarize it in one sentence. Then tell me what's on my calendar tomorrow morning.";

// The boss may iterate a few times: gmail.search → load_integration →
// calendar.list_events → final summary. Five minutes is comfortable.

const POLL_TIMEOUT_MS = 5 * 60_000;

async function pickGoogleConnectedUser(): Promise<{
  id: string;
  email: string;
} | null> {
  const rows = await db()
    .select({ id: userTable.id, email: userTable.email })
    .from(userTable)
    .innerJoin(
      integrationCredentials,
      eq(integrationCredentials.userId, userTable.id),
    )
    .where(
      and(
        eq(integrationCredentials.provider, "google"),
        eq(integrationCredentials.status, "active"),
      ),
    )
    .limit(1);
  return rows[0] ?? null;
}

async function ensureActionPolicyRow(userId: string): Promise<void> {
  await db()
    .insert(userActionPolicies)
    .values({ userId })
    .onConflictDoNothing({ target: userActionPolicies.userId });
}

async function resetSmokeRows(userId: string): Promise<void> {
  await db()
    .delete(agentRuns)
    .where(
      and(
        eq(agentRuns.userId, userId),
        eq(agentRuns.workflowSlug, WORKFLOW_SLUG),
      ),
    );
  await db()
    .delete(workflows)
    .where(
      and(eq(workflows.userId, userId), eq(workflows.slug, WORKFLOW_SLUG)),
    );
}

async function createSmokeWorkflow(userId: string): Promise<void> {
  await db()
    .insert(workflows)
    .values({
      userId,
      slug: WORKFLOW_SLUG,
      name: "Smoke brief execution",
      brief: SMOKE_BRIEF,
      trigger: { kind: "manual" },
      allowedIntegrations: ["gmail", "calendar"],
      status: "active",
      isBuiltin: false,
    });
}

interface PendingStaging {
  id: string;
  runId: string;
  toolName: string;
  proposedInput: unknown;
}

async function findPendingApprovals(runId: string): Promise<PendingStaging[]> {
  const rows = await db()
    .select({
      id: actionStagings.id,
      runId: actionStagings.runId,
      toolName: actionStagings.toolName,
      proposedInput: actionStagings.proposedInput,
    })
    .from(actionStagings)
    .where(
      and(
        eq(actionStagings.runId, runId),
        eq(actionStagings.status, "pending"),
        eq(actionStagings.requiresApproval, true),
      ),
    );
  return rows.map((r) => ({
    id: r.id,
    runId: r.runId,
    toolName: r.toolName,
    proposedInput: r.proposedInput,
  }));
}

async function autoApprove(staging: PendingStaging): Promise<void> {
  // Mirror the approvals route's transaction shape: flip the row, then
  // wake the parked run. enqueueRun re-claims a runnable row for the
  // worker pool. Skip signal mismatch reporting — the run may have
  // moved on between our SELECT and UPDATE; the next poll will catch
  // any remaining pending rows.
  const now = new Date();
  await db()
    .update(actionStagings)
    .set({
      status: "approved",
      decidedAt: now,
      rowVersion: sql`${actionStagings.rowVersion} + 1`,
    })
    .where(eq(actionStagings.id, staging.id));

  await signalRun({
    runId: staging.runId,
    match: {
      kind: "hil",
      approvalId: staging.id,
      approvalKind: "action_staging",
    },
  });
  await enqueueRun(staging.runId);
  console.log(
    `[smoke-brief-execution]   auto-approved ${staging.toolName} (${staging.id})`,
  );
}

async function pollAndAutoApprove(runId: string): Promise<{
  status: string;
  output: unknown;
  state: Record<string, unknown>;
}> {
  const deadline = Date.now() + POLL_TIMEOUT_MS;
  let lastStep: string | null = null;
  while (Date.now() < deadline) {
    const rows = await db()
      .select()
      .from(agentRuns)
      .where(eq(agentRuns.id, runId));
    const row = rows[0];
    if (!row) throw new Error(`run ${runId} not found`);
    if (row.currentStep !== lastStep) {
      console.log(
        `[smoke-brief-execution]   step → ${row.currentStep} (status=${row.status})`,
      );
      lastStep = row.currentStep;
    }
    if (row.status === "waiting") {
      const pending = await findPendingApprovals(runId);
      for (const p of pending) await autoApprove(p);
    }
    if (
      row.status === "completed" ||
      row.status === "failed" ||
      row.status === "cancelled"
    ) {
      return {
        status: row.status,
        output: row.output,
        state: toRecord(row.state),
      };
    }
    await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
  }
  throw new Error(`timed out waiting for run ${runId}`);
}

interface StagingSummary {
  toolName: string;
  status: string;
  requiresApproval: boolean;
}

async function loadStagingsForRun(runId: string): Promise<StagingSummary[]> {
  const rows = await db()
    .select({
      toolName: actionStagings.toolName,
      status: actionStagings.status,
      requiresApproval: actionStagings.requiresApproval,
    })
    .from(actionStagings)
    .where(eq(actionStagings.runId, runId));
  return rows.map((r) => ({
    toolName: r.toolName,
    status: r.status,
    requiresApproval: r.requiresApproval,
  }));
}

async function countStepRows(runId: string, stepId: string): Promise<number> {
  const rows = await db()
    .select({ count: sql<number>`count(*)::int` })
    .from(agentSteps)
    .where(and(eq(agentSteps.runId, runId), eq(agentSteps.stepId, stepId)));
  return rows[0]?.count ?? 0;
}

async function countApiCalls(runId: string): Promise<number> {
  const rows = await db()
    .select({ count: sql<number>`count(*)::int` })
    .from(apiCallLog)
    .where(eq(apiCallLog.runId, runId));
  return rows[0]?.count ?? 0;
}

function isStringArray(v: unknown): v is string[] {
  return Array.isArray(v) && v.every((s) => typeof s === "string");
}

async function main(): Promise<void> {
  await warmPool();
  // Workflow + tool registration runs inside the server process that
  // owns the agent worker. We register here too so any direct calls
  // (e.g. signalRun) and the resolver's DB-fallback path resolve
  // cleanly inside this script's process. registerBuiltinWorkflows
  // also seeds registerBuiltinTools via the bootstrap.
  registerBuiltinWorkflows();

  const target = await pickGoogleConnectedUser();
  if (!target) {
    console.log(
      "[smoke-brief-execution] no user with an active google credential — connect Gmail+Calendar in the web app first.",
    );
    return;
  }
  console.log(
    `[smoke-brief-execution] target: ${target.email} (id=${target.id})`,
  );

  await ensureActionPolicyRow(target.id);
  await resetSmokeRows(target.id);
  await createSmokeWorkflow(target.id);

  const { runId } = await createRun({
    userId: target.id,
    workflowSlug: WORKFLOW_SLUG,
    trigger: { kind: "manual" },
  });
  await enqueueRun(runId);
  console.log(`[smoke-brief-execution] run enqueued: ${runId}`);

  const final = await pollAndAutoApprove(runId);
  assert(
    final.status === "completed",
    `run did not complete: status=${final.status} output=${JSON.stringify(final.output)}`,
  );

  const bossTurnCount = await countStepRows(runId, "boss-turn");
  const dispatchToolsCount = await countStepRows(runId, "dispatch-tools");
  console.log(
    `[smoke-brief-execution] step rows: boss-turn=${bossTurnCount} dispatch-tools=${dispatchToolsCount}`,
  );
  assert(
    bossTurnCount >= 2,
    `expected ≥ 2 boss-turn step rows, got ${bossTurnCount}`,
  );
  assert(
    dispatchToolsCount >= 2,
    `expected ≥ 2 dispatch-tools step rows, got ${dispatchToolsCount}`,
  );

  const stagings = await loadStagingsForRun(runId);
  console.log(
    `[smoke-brief-execution] action_stagings rows: ${stagings.length}`,
  );
  for (const s of stagings) {
    console.log(
      `   - ${s.toolName} status=${s.status} requiresApproval=${s.requiresApproval}`,
    );
  }
  const executedToolNames = new Set(
    stagings.filter((s) => s.status === "executed").map((s) => s.toolName),
  );
  assert(
    executedToolNames.has("system.load_integration"),
    "expected an executed system.load_integration staging",
  );
  assert(
    Array.from(executedToolNames).some((n) => n.startsWith("gmail.")),
    "expected at least one executed gmail.* staging",
  );
  assert(
    Array.from(executedToolNames).some((n) => n.startsWith("calendar.")),
    "expected at least one executed calendar.* staging",
  );

  const activeIntegrations = final.state.activeIntegrations;
  assert(
    isStringArray(activeIntegrations),
    `expected state.activeIntegrations to be string[], got ${JSON.stringify(activeIntegrations)}`,
  );
  assert(
    activeIntegrations.includes("calendar"),
    `state.activeIntegrations did not grow to include 'calendar': ${JSON.stringify(activeIntegrations)}`,
  );

  const apiCallCount = await countApiCalls(runId);
  console.log(
    `[smoke-brief-execution] api_call_log rows for run: ${apiCallCount}`,
  );
  assert(
    apiCallCount === bossTurnCount,
    `expected api_call_log count (${apiCallCount}) to equal boss-turn count (${bossTurnCount})`,
  );

  const outputText =
    typeof final.output === "object" &&
    final.output !== null &&
    "text" in final.output
      ? (final.output as { text: unknown }).text
      : null;
  assert(
    typeof outputText === "string" && outputText.trim().length > 0,
    `expected non-empty output.text, got ${JSON.stringify(final.output)}`,
  );
  console.log(`[smoke-brief-execution] output.text:\n${outputText}`);

  console.log("\n[smoke-brief-execution] PASS");
}

try {
  await main();
} catch (err) {
  console.error(
    "[smoke-brief-execution] FAIL",
    err instanceof Error ? (err.stack ?? err.message) : err,
  );
  process.exitCode = 1;
} finally {
  await closeAgentQueue().catch(() => {});
  await closeRedis().catch(() => {});
  await closeConnections().catch(() => {});
}
