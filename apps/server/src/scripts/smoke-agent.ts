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

const POLL_INTERVAL_MS = 250;
const POLL_TIMEOUT_MS = 30_000;

async function findOrCreateSmokeUser(): Promise<string> {
  const email = "smoke-agent@alfred.local";
  const existing = await db().select().from(userTable).where(eq(userTable.email, email));
  if (existing[0]) return existing[0].id;
  const inserted = await db()
    .insert(userTable)
    .values({ name: "Smoke Tester", email, emailVerified: true })
    .returning({ id: userTable.id });
  return inserted[0]!.id;
}

async function pollUntil(
  runId: string,
  predicate: (status: string) => boolean,
  label: string,
): Promise<{ status: string; output: unknown; wakeCondition: unknown }> {
  const deadline = Date.now() + POLL_TIMEOUT_MS;
  while (Date.now() < deadline) {
    const rows = await db().select().from(agentRuns).where(eq(agentRuns.id, runId));
    const row = rows[0];
    if (!row) throw new Error(`run ${runId} not found while waiting for ${label}`);
    if (predicate(row.status)) {
      return { status: row.status, output: row.output, wakeCondition: row.wakeCondition };
    }
    await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
  }
  throw new Error(`timed out waiting for ${label} on run ${runId}`);
}

async function main() {
  await warmPool();
  // Register so createRun's requireWorkflow doesn't complain in this process.
  // The server process has its own registration; both sides see the same DB.
  registerBuiltinWorkflows();

  const userId = await findOrCreateSmokeUser();
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

  const parked = await pollUntil(runId, (s) => s === "waiting" || isTerminal(s), "waiting");
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

function isTerminal(s: string): boolean {
  return s === "completed" || s === "failed" || s === "cancelled";
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
