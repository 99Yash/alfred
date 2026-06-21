/**
 * Smoke test for the m5 durable agent runtime.
 *
 *   $ pnpm --filter server tsx --env-file=.env src/scripts/smoke-agent.ts
 *
 * The server (also reading from the same Postgres + Redis) is what
 * actually runs the steps; this script just creates a run, watches it
 * progress, signals the HIL approval, and asserts the final output.
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
import { db } from "@alfred/db";
import { agentRuns, agentSteps, user as userTable } from "@alfred/db/schemas";
import { eq } from "drizzle-orm";
import { registerBuiltinWorkflows } from "../builtins";
import {
  POLL_INTERVAL_MS,
  POLL_TIMEOUT_MS,
  findOrCreateSmokeUser,
  isTerminal,
  pollUntil,
} from "./_smoke-helpers";

async function main() {
  await warmPool();
  // Register so createRun's requireWorkflow doesn't complain in this process.
  // The server process has its own registration; both sides see the same DB.
  registerBuiltinWorkflows();

  const userId = await findOrCreateSmokeUser("smoke-agent@alfred.local");
  console.log(`[smoke] userId=${userId}`);

  const { runId } = await createRun({
    userId,
    workflowSlug: "echo-with-approval",
    brief: "smoke test",
    input: { greeting: "hello durable runtime" },
    trigger: { kind: "manual" },
  });
  console.log(`[smoke] created runId=${runId}`);

  await enqueueRun(runId);
  console.log("[smoke] enqueued; waiting for HIL interrupt…");

  const parked = await pollUntil(
    runId,
    (s) => s === "waiting" || isTerminal(s),
    "waiting",
  );
  if (parked.status !== "waiting") {
    throw new Error(`expected waiting, got ${parked.status}`);
  }
  const wake = parked.wakeCondition as { kind: string; approvalId: string };
  console.log(`[smoke] interrupted; wake=${JSON.stringify(wake)}`);

  if (wake.kind !== "hil") throw new Error(`unexpected wake kind ${wake.kind}`);

  const woken = await signalRun({
    runId,
    match: { kind: "hil", approvalId: wake.approvalId },
  });
  if (!woken) throw new Error("signal failed to wake the run");
  await enqueueRun(runId);
  console.log("[smoke] approval signaled; waiting for completion…");

  const done = await pollUntil(runId, isTerminal, "completion");
  if (done.status !== "completed") {
    throw new Error(`expected completed, got ${done.status}`);
  }
  const output = done.output as { echoed?: string };
  if (output?.echoed !== "HELLO DURABLE RUNTIME") {
    throw new Error(`unexpected output: ${JSON.stringify(output)}`);
  }
  console.log(`[smoke] completed; output=${JSON.stringify(output)}`);

  // Sanity: every step row landed and idempotency keys are unique.
  const stepRows = await db()
    .select()
    .from(agentSteps)
    .where(eq(agentSteps.runId, runId))
    .orderBy(agentSteps.id);
  console.log(`[smoke] step rows for ${runId}:`);
  for (const s of stepRows) {
    console.log(`   - ${s.stepId} attempt=${s.attempt} status=${s.status}`);
  }

  console.log("\n[smoke] PASS");
}

main()
  .catch((err) => {
    console.error("[smoke] FAIL", err instanceof Error ? err.message : err);
    process.exitCode = 1;
  })
  .finally(async () => {
    await closeAgentQueue().catch(() => {});
    await closeRedis().catch(() => {});
    await closeConnections().catch(() => {});
  });
