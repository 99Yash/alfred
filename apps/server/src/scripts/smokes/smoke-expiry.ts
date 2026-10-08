/**
 * Smoke test for approval expiry on real Postgres and Redis, with a stub tool.
 * It calls `expireStaging` directly instead of waiting 24h for the job.
 * Covers: staging sets `expires_at` and queues a job; expiry wakes the run and a
 * re-dispatch returns 'auto-expired' without executing; a human decision wins;
 * `removeApprovalExpiryJob` cancels the timer.
 *
 *   $ pnpm --filter server tsx --env-file=.env src/scripts/smokes/smoke-expiry.ts
 */

import { getStringPath } from "@alfred/contracts";
import {
  approvalExpiryJobId,
  getApprovalExpiryQueue,
  removeApprovalExpiryJob,
} from "@alfred/assistant/tool-runtime";

import { dispatchToolCall } from "@alfred/assistant/tool-runtime/dispatch";
import { expireStaging } from "@alfred/assistant/execution";
import { clearToolRegistryForTests, liveTool, registerTools } from "@alfred/assistant/tool-runtime";
import { closeConnections, warmPool } from "@alfred/db";
import { closeRedis } from "@alfred/db/redis";
import {
  bustPolicyCache,
  ensureDefaultActionPolicyForUser,
} from "@alfred/assistant/action-policies";
import { APPROVAL_EXPIRY_MS } from "@alfred/contracts";
import { db } from "@alfred/db";
import {
  actionStagings,
  agentRuns,
  user as userTable,
  userActionPolicies,
} from "@alfred/db/schemas";
import { and, eq } from "drizzle-orm";
import { z } from "zod";

const SMOKE_USER_EMAIL = "smoke-expiry@alfred.local";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`[smoke-expiry] ${message}`);
}

async function findOrCreateSmokeUser(): Promise<string> {
  const existing = await db().select().from(userTable).where(eq(userTable.email, SMOKE_USER_EMAIL));

  if (existing[0]) return existing[0].id;

  const inserted = await db()
    .insert(userTable)
    .values({ name: "Expiry Smoke", email: SMOKE_USER_EMAIL, emailVerified: true })
    .returning({ id: userTable.id });

  if (!inserted[0]) throw new Error("failed to insert smoke user");

  return inserted[0].id;
}

async function createSmokeRun(userId: string, label: string): Promise<string> {
  const inserted = await db()
    .insert(agentRuns)
    .values({
      userId,
      workflowSlug: "smoke-expiry",
      currentStep: label,
      status: "running",
      trigger: { kind: "manual" },
    })
    .returning({ id: agentRuns.id });

  if (!inserted[0]) throw new Error("failed to insert smoke run");

  return inserted[0].id;
}

async function setGated(userId: string): Promise<void> {
  await db()
    .update(userActionPolicies)
    .set({ integrationRules: { system: { mode: "autonomy" }, gmail: { mode: "gated" } } })
    .where(eq(userActionPolicies.userId, userId));
  bustPolicyCache(userId);
}

/** Park the run on the HIL wake, as the executor does on interrupt. */
async function parkRunOnApproval(runId: string, stagingId: string): Promise<void> {
  await db()
    .update(agentRuns)
    .set({
      status: "waiting",
      wakeCondition: {
        kind: "hil",
        approvalId: stagingId,
        approvalKind: "action_staging",
        prompt: "Approve gmail.send_draft",
      },
    })
    .where(eq(agentRuns.id, runId));
}

const sendDraftInput = z
  .object({
    to: z.array(z.string().email()).min(1).max(25),
    subject: z.string().min(1).max(1000),
    bodyText: z.string().min(1).max(50_000),
  })
  .strict();

const DRAFT_INPUT = { to: ["yash@example.com"], subject: "expiry smoke", bodyText: "hi" };

async function stageGatedDraft(userId: string, runId: string, toolCallId: string): Promise<string> {
  const staged = await dispatchToolCall({
    runId,
    stepId: "turn-1",
    toolCallId,
    toolName: "gmail.send_draft",
    activeTools: ["gmail.send_draft"],
    input: DRAFT_INPUT,
    userId,
    caller: "boss",
    runContext: { caller: "boss", interaction: "background" },
    fence: { generation: 0 },
  });

  assert(staged.kind === "staged", `expected 'staged', got '${staged.kind}'`);

  return staged.stagingId;
}

async function main(): Promise<void> {
  await warmPool();
  clearToolRegistryForTests();

  let draftExec = 0;
  registerTools([
    liveTool({
      integration: "gmail",
      action: "send_draft",
      riskTier: "high",
      description: "Smoke-test Gmail draft send tool.",
      inputSchema: sendDraftInput,
      execute: async (input) => {
        draftExec += 1;

        return { sentTo: input.to[0], subject: input.subject };
      },
    }),
  ]);

  const userId = await findOrCreateSmokeUser();
  await ensureDefaultActionPolicyForUser(userId);
  await setGated(userId);

  const queue = getApprovalExpiryQueue();

  // 1. Staging sets expires_at + queues an expiry job
  const runId1 = await createSmokeRun(userId, "expire-turn");
  const stagedId = await stageGatedDraft(userId, runId1, "tc_expire_1");

  const stagedRow = (
    await db().select().from(actionStagings).where(eq(actionStagings.id, stagedId))
  )[0];

  assert(
    stagedRow?.status === "pending",
    `staged row expected 'pending', got '${stagedRow?.status}'`,
  );
  assert(stagedRow.expiresAt instanceof Date, "staged gated row must carry expires_at");
  const expiresInMs = stagedRow.expiresAt.getTime() - Date.now();
  assert(
    Math.abs(expiresInMs - APPROVAL_EXPIRY_MS) < 5 * 60_000,
    `expires_at should be ≈ now + APPROVAL_EXPIRY_MS, off by ${expiresInMs - APPROVAL_EXPIRY_MS}ms`,
  );
  const queuedJob = await queue.getJob(approvalExpiryJobId(stagedId));
  assert(queuedJob, "dispatcher must enqueue a staging-expire job for a gated row");
  console.log("[smoke-expiry] 1. staging: expires_at set, expiry job queued ✓");

  // 2. expireStaging on a parked, pending row
  await parkRunOnApproval(runId1, stagedId);
  const expired = await expireStaging({ stagingId: stagedId, userId });
  assert(expired.status === "expired", `expireStaging expected 'expired', got '${expired.status}'`);
  assert(draftExec === 0, "expiry must not execute the tool");

  const expiredRow = (
    await db().select().from(actionStagings).where(eq(actionStagings.id, stagedId))
  )[0];

  assert(expiredRow?.status === "expired", `row expected 'expired', got '${expiredRow?.status}'`);
  assert(
    expiredRow.rejectReason === "auto-expired",
    "expired row must record reason 'auto-expired'",
  );
  assert(expiredRow.decidedAt != null, "expired row must carry decided_at");
  assert(
    expiredRow.rowVersion === stagedRow.rowVersion + 1,
    `expired row must bump row_version (${stagedRow.rowVersion} → ${expiredRow.rowVersion})`,
  );

  const wokenRun = (await db().select().from(agentRuns).where(eq(agentRuns.id, runId1)))[0];
  assert(
    wokenRun?.status === "runnable",
    `run expected 'runnable' after wake, got '${wokenRun?.status}'`,
  );
  assert(wokenRun.wakeCondition === null, "woken run must clear its wake_condition");
  console.log("[smoke-expiry] 2. expired: row=expired/auto-expired, run woken ✓");

  // The resumed executor sees an auto-expired rejection, and the tool does not run.
  const reDispatched = await dispatchToolCall({
    runId: runId1,
    stepId: "turn-1",
    toolCallId: "tc_expire_1",
    toolName: "gmail.send_draft",
    activeTools: ["gmail.send_draft"],
    input: DRAFT_INPUT,
    userId,
    caller: "boss",
    runContext: { caller: "boss", interaction: "background" },
    fence: { generation: 0 },
  });

  assert(
    reDispatched.kind === "rejected",
    `re-dispatch of expired row expected 'rejected', got '${reDispatched.kind}'`,
  );
  assert(
    getStringPath(reDispatched, "result", "reason") === "auto-expired",
    "re-dispatch must synthesize reason='auto-expired'",
  );
  assert(draftExec === 0, "re-dispatch of expired row must not execute the tool");
  console.log("[smoke-expiry] 2. re-dispatch: synthesized auto-expired rejection, tool not run ✓");

  const expiredAgain = await expireStaging({ stagingId: stagedId, userId });
  assert(
    expiredAgain.status === "skipped" && expiredAgain.reason === "expired",
    `second expireStaging expected skipped/expired, got '${expiredAgain.status}'/'${expiredAgain.reason}'`,
  );
  console.log("[smoke-expiry] 2. idempotent: second expire is a no-op ✓");

  // 3. Human decision wins over expiry
  const runId2 = await createSmokeRun(userId, "decided-turn");
  const decidedId = await stageGatedDraft(userId, runId2, "tc_expire_2");
  await db()
    .update(actionStagings)
    .set({ status: "approved", decidedAt: new Date() })
    .where(eq(actionStagings.id, decidedId));

  const skipped = await expireStaging({ stagingId: decidedId, userId });
  assert(
    skipped.status === "skipped" && skipped.reason === "approved",
    `expireStaging on approved row expected skipped/approved, got '${skipped.status}'/'${skipped.reason}'`,
  );

  const stillApproved = (
    await db().select().from(actionStagings).where(eq(actionStagings.id, decidedId))
  )[0];

  assert(stillApproved?.status === "approved", "human-approved row must remain 'approved'");
  console.log("[smoke-expiry] 3. decided row: expiry no-ops, approval preserved ✓");

  // 4. removeApprovalExpiryJob dequeues the fallback timer
  const runId3 = await createSmokeRun(userId, "cancel-job-turn");
  const cancelId = await stageGatedDraft(userId, runId3, "tc_expire_3");
  assert(
    await queue.getJob(approvalExpiryJobId(cancelId)),
    "expiry job should be queued after staging",
  );
  await removeApprovalExpiryJob(cancelId);
  const goneJob = await queue.getJob(approvalExpiryJobId(cancelId));
  assert(!goneJob, "removeApprovalExpiryJob must dequeue the staging-expire job");
  console.log("[smoke-expiry] 4. removeApprovalExpiryJob: job dequeued ✓");

  // cleanup
  for (const id of [stagedId, decidedId, cancelId]) {
    await removeApprovalExpiryJob(id);
  }

  for (const runId of [runId1, runId2, runId3]) {
    await db().delete(actionStagings).where(eq(actionStagings.runId, runId));
    await db()
      .delete(agentRuns)
      .where(and(eq(agentRuns.id, runId), eq(agentRuns.userId, userId)));
  }

  console.log("[smoke-expiry] cleanup ok");
}

try {
  await main();
  console.log("[smoke-expiry] PASS");
} catch (err) {
  console.error("[smoke-expiry] FAIL", err);
  process.exitCode = 1;
} finally {
  await closeRedis();
  await closeConnections();
}
