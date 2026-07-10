/**
 * Verifies that a `waiting` run created in a previous boot is still
 * resumable. Run after restarting the dev server while a parked run
 * exists — we use the run id left behind by smoke-agent-restart.ts.
 *
 *   $ pnpm tsx --env-file=.env src/scripts/smokes/smoke-agent-resume.ts <runId>
 */
import {
  enqueueRun,
  signalRun,
} from "@alfred/api/backend";
import { closeAgentQueue, closeConnections, closeRedis, warmPool } from "@alfred/api/runtime";
import { db } from "@alfred/db";
import { agentRuns } from "@alfred/db/schemas";
import { eq } from "drizzle-orm";

async function main() {
  const runId = process.argv[2];
  if (!runId) throw new Error("usage: smoke-agent-resume.ts <runId>");
  await warmPool();

  const rows = await db().select().from(agentRuns).where(eq(agentRuns.id, runId));
  const row = rows[0];
  if (!row) throw new Error(`run ${runId} not found`);
  console.log(`[resume] runId=${runId} status=${row.status}`);
  console.log(`[resume] currentStep=${row.currentStep} attempt=${row.attempt}`);
  console.log(`[resume] wakeCondition=${JSON.stringify(row.wakeCondition)}`);

  if (row.status !== "waiting") {
    throw new Error(`expected waiting, got ${row.status}`);
  }

  const wake = row.wakeCondition as { kind: string; approvalId: string } | null;
  if (!wake || wake.kind !== "hil") throw new Error("expected HIL wake");

  const woken = await signalRun({
    runId,
    match: { kind: "hil", approvalId: wake.approvalId },
  });
  if (!woken) throw new Error("signal failed");
  await enqueueRun(runId);
  console.log("[resume] signaled; polling for completion…");

  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    const after = await db().select().from(agentRuns).where(eq(agentRuns.id, runId));
    const r = after[0]!;
    if (r.status === "completed") {
      console.log(`[resume] completed; output=${JSON.stringify(r.output)}`);
      console.log("\n[resume] PASS — run survived restart and completed");
      return;
    }
    if (r.status === "failed" || r.status === "cancelled") {
      throw new Error(`unexpected terminal status ${r.status}`);
    }
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error("timed out waiting for completion");
}

main()
  .catch((err) => {
    console.error("[resume] FAIL", err instanceof Error ? err.message : err);
    process.exitCode = 1;
  })
  .finally(async () => {
    await closeAgentQueue().catch(() => {});
    await closeRedis().catch(() => {});
    await closeConnections().catch(() => {});
  });
