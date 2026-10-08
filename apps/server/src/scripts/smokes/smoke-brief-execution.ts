/**
 * End-to-end smoke for a brief-only run: the run completes, Calendar tools
 * activate mid-run, stagings land, one `api_call_log` row per boss turn
 * (ADR-0026), and the output has a summary.
 *
 *   $ pnpm --filter server tsx --env-file=.env src/scripts/smokes/smoke-brief-execution.ts
 *
 * Pre-reqs:
 *   - A server process running (`pnpm dev`). This script auto-approves pending stagings.
 *   - A user with Google connected (gmail + calendar scopes).
 */

import { randomUUID } from "node:crypto";
import { redeliverRun, signalRun, startRun, closeAgentQueue } from "@alfred/assistant/execution";
import { warmPool } from "@alfred/db";
import { getStringPath, toRecord } from "@alfred/contracts";
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
import { registerBuiltinWorkflows } from "~/builtins";
import { closeScriptResources } from "../script-runtime";

const WORKFLOW_SLUG = "smoke-brief-execution";

const SMOKE_BRIEF =
  "@gmail — Read my most recent inbox email and summarize it in one sentence. Then tell me what's on my calendar tomorrow morning.";

const POLL_INTERVAL_MS = 500;

const POLL_TIMEOUT_MS = 5 * 60_000;

function assert(cond: unknown, msg: string): asserts cond {
  if (!cond) throw new Error(`[smoke-brief-execution] assertion failed: ${msg}`);
}

async function pickGoogleConnectedUser(): Promise<{ id: string; email: string } | null> {
  const rows = await db()
    .select({ id: userTable.id, email: userTable.email })
    .from(userTable)
    .innerJoin(integrationCredentials, eq(integrationCredentials.userId, userTable.id))
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
    .where(and(eq(agentRuns.userId, userId), eq(agentRuns.workflowSlug, WORKFLOW_SLUG)));
  await db()
    .delete(workflows)
    .where(and(eq(workflows.userId, userId), eq(workflows.slug, WORKFLOW_SLUG)));
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
  // Like the approvals route: flip the row, then wake the run. A missed signal
  // is fine; the next poll retries.
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
    match: { kind: "hil", approvalId: staging.id, approvalKind: "action_staging" },
  });
  await redeliverRun(staging.runId);
  console.log(`[smoke-brief-execution]   auto-approved ${staging.toolName} (${staging.id})`);
}

async function pollAndAutoApprove(runId: string): Promise<{
  status: string;
  output: unknown;
  state: Record<string, unknown>;
}> {
  const deadline = Date.now() + POLL_TIMEOUT_MS;
  let lastStep: string | null = null;

  while (Date.now() < deadline) {
    const rows = await db().select().from(agentRuns).where(eq(agentRuns.id, runId));
    const row = rows[0];

    if (!row) throw new Error(`run ${runId} not found`);

    if (row.currentStep !== lastStep) {
      console.log(`[smoke-brief-execution]   step → ${row.currentStep} (status=${row.status})`);
      lastStep = row.currentStep;
    }

    if (row.status === "waiting") {
      const pending = await findPendingApprovals(runId);

      for (const p of pending) await autoApprove(p);
    }

    if (row.status === "completed" || row.status === "failed" || row.status === "cancelled") {
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
  // Register here too, so direct calls like signalRun resolve in this process.
  registerBuiltinWorkflows();

  const target = await pickGoogleConnectedUser();

  if (!target) {
    console.log(
      "[smoke-brief-execution] no user with an active google credential — connect Gmail+Calendar in the web app first.",
    );

    return;
  }

  console.log(`[smoke-brief-execution] target: ${target.email} (id=${target.id})`);

  await ensureActionPolicyRow(target.id);
  await resetSmokeRows(target.id);
  await createSmokeWorkflow(target.id);

  const { runId } = await startRun({
    userId: target.id,
    workflowSlug: WORKFLOW_SLUG,
    trigger: { kind: "manual" },
    occurrence: { kind: "manual", requestId: randomUUID() },
  });

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
  assert(bossTurnCount >= 2, `expected ≥ 2 boss-turn step rows, got ${bossTurnCount}`);
  assert(
    dispatchToolsCount >= 2,
    `expected ≥ 2 dispatch-tools step rows, got ${dispatchToolsCount}`,
  );

  const stagings = await loadStagingsForRun(runId);
  console.log(`[smoke-brief-execution] action_stagings rows: ${stagings.length}`);

  for (const s of stagings) {
    console.log(`   - ${s.toolName} status=${s.status} requiresApproval=${s.requiresApproval}`);
  }

  const executedToolNames = new Set(
    stagings.filter((s) => s.status === "executed").map((s) => s.toolName),
  );

  assert(
    Array.from(executedToolNames).some((n) => n.startsWith("gmail.")),
    "expected at least one executed gmail.* staging",
  );
  assert(
    Array.from(executedToolNames).some((n) => n.startsWith("calendar.")),
    "expected at least one executed calendar.* staging",
  );

  const activeTools = final.state.activeTools;
  assert(
    isStringArray(activeTools),
    `expected state.activeTools to be string[], got ${JSON.stringify(activeTools)}`,
  );
  assert(
    activeTools.includes("calendar.list_events"),
    `state.activeTools did not grow to include calendar.list_events: ${JSON.stringify(activeTools)}`,
  );

  const apiCallCount = await countApiCalls(runId);
  console.log(`[smoke-brief-execution] api_call_log rows for run: ${apiCallCount}`);
  assert(
    apiCallCount === bossTurnCount,
    `expected api_call_log count (${apiCallCount}) to equal boss-turn count (${bossTurnCount})`,
  );

  const outputText = getStringPath(final.output, "text") ?? null;
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
  await closeScriptResources(closeAgentQueue);
}
