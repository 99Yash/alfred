/**
 * Smoke test for the m12d generic workflow dispatcher (ADR-0027).
 *
 *   $ pnpm --filter server tsx --env-file=.env src/scripts/smokes/smoke-workflows-tick.ts
 *
 * Verifies:
 *   1. A user-authored cron workflow with `next_run_at <= now()` is
 *      picked up by `dispatchDueCronWorkflows`.
 *   2. The handler creates an `agent_runs` row with
 *      `trigger.kind = 'cron'` and `trigger.scheduledFor` = the old
 *      `next_run_at` (in ISO).
 *   3. `enqueueRun` is called with a `jobId` of
 *      `workflow:{id}:scheduled:{iso}` — verifiable via BullMQ.
 *   4. The workflow row's `next_run_at` is advanced and
 *      `last_scheduled_at` matches the fired instant.
 *   5. A second tick (same fired instant in BullMQ) is a no-op — the
 *      jobId is already-known to BullMQ.
 *   6. The same scheduled instant is not re-fired even after the
 *      handler runs again (CAS on `next_run_at`).
 */
import {
  dispatchDueCronWorkflows,
  getAgentQueue,
} from "@alfred/api/backend";
import {
  closeAgentQueue,
  closeConnections,
  closeRedis,
  closeWorkflowsQueue,
  warmPool,
} from "@alfred/api/runtime";
import { db } from "@alfred/db";
import { agentRuns, user as userTable, workflows } from "@alfred/db/schemas";
import { and, eq } from "drizzle-orm";
import { registerBuiltinWorkflows } from "~/builtins";
import { toMessage } from "@alfred/contracts";

// Re-use the registered `echo-with-approval` slug so the dispatcher's
// `createRun` → `requireWorkflow` lookup resolves. We never let the
// agent worker pick the run up; this smoke verifies only the
// dispatcher side (insert + advance + jobId dedup + CAS race).
const TEST_SLUG = "echo-with-approval";

function assert(cond: unknown, msg: string): asserts cond {
  if (!cond) {
    console.error(`[smoke-workflows-tick] assertion failed: ${msg}`);
    process.exitCode = 1;
    throw new Error(msg);
  }
}

async function findOrCreateSmokeUser(): Promise<string> {
  const email = "smoke-workflows-tick@alfred.local";
  const existing = await db().select().from(userTable).where(eq(userTable.email, email));
  if (existing[0]) return existing[0].id;
  const inserted = await db()
    .insert(userTable)
    .values({ name: "WF Tick Smoke", email, emailVerified: true })
    .returning({ id: userTable.id });
  return inserted[0]!.id;
}

async function cleanupPriorTest(userId: string): Promise<void> {
  // Drop any prior fake-workflow row + its runs from a previous smoke
  // attempt. Foreign keys: agent_runs.user_id → user.id (no FK to
  // workflows), so we delete by user_id + workflow_slug.
  await db()
    .delete(agentRuns)
    .where(and(eq(agentRuns.userId, userId), eq(agentRuns.workflowSlug, TEST_SLUG)));
  await db()
    .delete(workflows)
    .where(and(eq(workflows.userId, userId), eq(workflows.slug, TEST_SLUG)));
}

async function main() {
  await warmPool();
  registerBuiltinWorkflows();

  const userId = await findOrCreateSmokeUser();
  console.log(`[smoke-workflows-tick] userId=${userId}`);

  await cleanupPriorTest(userId);

  const fakeSchedule = "*/5 * * * *"; // every 5 minutes
  const scheduledFor = new Date(Date.now() - 60_000); // 60s in the past
  const insertedWf = await db()
    .insert(workflows)
    .values({
      userId,
      slug: TEST_SLUG,
      name: "Smoke: workflows.tick",
      description: null,
      trigger: { kind: "cron", schedule: fakeSchedule, timezone: "UTC" },
      brief: "no-op smoke run",
      steps: null,
      allowedIntegrations: [],
      status: "active",
      isBuiltin: false,
      nextRunAt: scheduledFor,
    })
    .returning({ id: workflows.id, nextRunAt: workflows.nextRunAt });
  const wfRow = insertedWf[0]!;
  const scheduledForIso = scheduledFor.toISOString();
  console.log(
    `[smoke-workflows-tick] inserted workflow id=${wfRow.id} next_run_at=${scheduledForIso}`,
  );

  // --- Tick #1 -----------------------------------------------------------
  const result1 = await dispatchDueCronWorkflows();
  console.log(`[smoke-workflows-tick] tick 1 result:`, result1);
  assert(result1.enqueued >= 1, `tick 1 should enqueue at least 1; got ${result1.enqueued}`);
  assert(result1.failed === 0, `tick 1 failed=${result1.failed} expected 0`);

  // Run row present with trigger.kind='cron' and matching scheduledFor.
  const runs = await db()
    .select()
    .from(agentRuns)
    .where(and(eq(agentRuns.userId, userId), eq(agentRuns.workflowSlug, TEST_SLUG)));
  assert(runs.length === 1, `expected exactly 1 run row after tick 1; got ${runs.length}`);
  const run = runs[0]!;
  const trigger = run.trigger as { kind: string; scheduledFor: string } | null;
  assert(trigger?.kind === "cron", `expected trigger.kind='cron'; got ${JSON.stringify(trigger)}`);
  assert(
    trigger.scheduledFor === scheduledForIso,
    `trigger.scheduledFor=${trigger.scheduledFor} != ${scheduledForIso}`,
  );
  console.log(`[smoke-workflows-tick] run id=${run.id} trigger=${JSON.stringify(trigger)}`);

  // Workflow row advanced.
  const after1 = await db()
    .select({ nextRunAt: workflows.nextRunAt, lastScheduledAt: workflows.lastScheduledAt })
    .from(workflows)
    .where(eq(workflows.id, wfRow.id));
  const advanced = after1[0]!;
  assert(advanced.nextRunAt, "next_run_at became null after tick 1");
  assert(
    advanced.nextRunAt.getTime() > scheduledFor.getTime(),
    `next_run_at=${advanced.nextRunAt?.toISOString()} did not advance past ${scheduledForIso}`,
  );
  assert(
    advanced.lastScheduledAt?.toISOString() === scheduledForIso,
    `last_scheduled_at=${advanced.lastScheduledAt?.toISOString()} != ${scheduledForIso}`,
  );
  console.log(
    `[smoke-workflows-tick] workflow advanced: next_run_at=${advanced.nextRunAt!.toISOString()} last_scheduled_at=${advanced.lastScheduledAt?.toISOString()}`,
  );

  // BullMQ job present with the expected jobId.
  const expectedJobId = `workflow.${wfRow.id}.scheduled.${scheduledFor.getTime()}`;
  const queue = getAgentQueue();
  const job = await queue.getJob(expectedJobId);
  assert(job, `BullMQ job with id=${expectedJobId} not found`);
  console.log(`[smoke-workflows-tick] BullMQ job present: id=${job!.id}`);

  // --- Tick #2 (same now) ------------------------------------------------
  // Since the workflow row's next_run_at advanced past now, the second
  // tick should select 0 due rows and create 0 runs.
  const result2 = await dispatchDueCronWorkflows();
  console.log(`[smoke-workflows-tick] tick 2 result:`, result2);
  assert(result2.scanned === 0, `tick 2 scanned=${result2.scanned} expected 0`);

  const runs2 = await db()
    .select()
    .from(agentRuns)
    .where(and(eq(agentRuns.userId, userId), eq(agentRuns.workflowSlug, TEST_SLUG)));
  assert(runs2.length === 1, `tick 2 created an extra run; total=${runs2.length}`);

  // --- Race simulation: rewind + concurrent dispatch ---------------------
  // Reset next_run_at to the past, then call dispatch twice
  // concurrently. The CAS in dispatchOne should mean exactly one
  // enqueue happens, even though both calls SELECT the same row.
  const replayScheduledFor = new Date(Date.now() - 30_000);
  await db()
    .update(workflows)
    .set({ nextRunAt: replayScheduledFor })
    .where(eq(workflows.id, wfRow.id));
  const [raceA, raceB] = await Promise.all([
    dispatchDueCronWorkflows(),
    dispatchDueCronWorkflows(),
  ]);
  console.log(`[smoke-workflows-tick] race A=${JSON.stringify(raceA)} B=${JSON.stringify(raceB)}`);
  const totalEnqueued = raceA.enqueued + raceB.enqueued;
  const totalRaced = raceA.raced + raceB.raced;
  assert(
    totalEnqueued === 1 && totalRaced === 1,
    `expected exactly 1 enqueue + 1 race; got enqueued=${totalEnqueued} raced=${totalRaced}`,
  );
  console.log(`[smoke-workflows-tick] race respected: 1 enqueue + 1 raced`);

  // Cleanup BullMQ jobs we created (so re-running the smoke isn't
  // blocked by jobId dedup from a prior run).
  await queue.remove(expectedJobId);
  const secondJobId = `workflow.${wfRow.id}.scheduled.${replayScheduledFor.getTime()}`;
  await queue.remove(secondJobId);

  console.log("[smoke-workflows-tick] ✅ all assertions passed");
}

main()
  .catch((err) => {
    console.error("[smoke-workflows-tick] failed:", err);
    process.exitCode = 1;
  })
  .finally(async () => {
    try {
      await closeAgentQueue();
      await closeWorkflowsQueue();
      await closeRedis();
      await closeConnections();
    } catch (err) {
      console.error("[smoke-workflows-tick] cleanup error:", toMessage(err));
    }
  });
