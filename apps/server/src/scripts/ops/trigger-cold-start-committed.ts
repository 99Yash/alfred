/**
 * Start a `cold-start-research` run for a user whose signup cold-start produced
 * nothing. It enqueues onto the prod BullMQ queue, so the prod worker runs it like a signup.
 *
 * The unique index on `agent_runs.dedup_key` allows one active run, so this cancels
 * an active prior run first. Bundled for prod. Dry by default; `--commit` cancels and enqueues.
 *
 *   # preview (writes nothing):
 *   node dist/scripts/ops/trigger-cold-start-committed.js
 *   # commit:
 *   node dist/scripts/ops/trigger-cold-start-committed.js --commit
 *   # override target(s):
 *   COLD_START_EMAILS="a@x.com,b@y.com" node dist/scripts/ops/trigger-cold-start-committed.js --commit
 */
import { randomUUID } from "node:crypto";
import { COLD_START_WORKFLOW_SLUG } from "@alfred/assistant/knowledge";
import { startRun, closeAgentQueue } from "@alfred/assistant/execution";
import { registerReplicachePokeAdapter } from "@alfred/assistant/realtime";
import { warmPool } from "@alfred/db";
import { db } from "@alfred/db";
import { agentRuns, user as userTable } from "@alfred/db/schemas";
import { and, eq, inArray, sql } from "drizzle-orm";
import { registerBuiltinWorkflows } from "~/builtins";
import { toMessage } from "@alfred/contracts";
import { closeScriptResources } from "../script-runtime";

/** Override with comma-separated `COLD_START_EMAILS`. */
const TARGET_EMAILS = (process.env.COLD_START_EMAILS ?? "yashgouravkar@gmail.com")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);

const COMMIT = process.argv.includes("--commit");

async function processUser(u: { userId: string; email: string }): Promise<void> {
  console.log(`\n=== ${u.email} (user=${u.userId}) ===`);

  const prior = await db()
    .select({ id: agentRuns.id, status: agentRuns.status })
    .from(agentRuns)
    .where(
      and(eq(agentRuns.userId, u.userId), eq(agentRuns.workflowSlug, COLD_START_WORKFLOW_SLUG)),
    );

  const active = prior.filter((r) => r.status !== "failed" && r.status !== "cancelled");
  console.log(
    `  prior cold-start runs: ${prior.length} (active=${active.length}: ${
      active.map((r) => `${r.id}:${r.status}`).join(", ") || "none"
    })`,
  );

  if (!COMMIT) {
    console.log("  [dry] no writes. Pass --commit to cancel-prior + enqueue.");

    return;
  }

  // Cancel an active prior run, or the unique index rejects the insert.
  if (active.length > 0) {
    const stomped = await db()
      .update(agentRuns)
      .set({ status: "cancelled", endedAt: new Date(), updatedAt: new Date() })
      .where(
        and(
          eq(agentRuns.userId, u.userId),
          eq(agentRuns.workflowSlug, COLD_START_WORKFLOW_SLUG),
          sql`${agentRuns.status} NOT IN ('failed', 'cancelled')`,
        ),
      )
      .returning({ id: agentRuns.id });

    console.log(`  cancelled ${stomped.length} active prior run(s)`);
  }

  const { runId } = await startRun({
    userId: u.userId,
    workflowSlug: COLD_START_WORKFLOW_SLUG,
    input: { reason: "manual" },
    metadata: { source: "trigger-cold-start-committed-2026-06-12" },
    trigger: { kind: "manual" },
    occurrence: { kind: "manual", requestId: randomUUID() },
  });

  console.log(`  enqueued cold-start run ${runId} (worker executes it)`);
}

async function main() {
  await warmPool();
  registerBuiltinWorkflows(); // createRun resolves builtins from the in-process registry
  registerReplicachePokeAdapter(); // enqueued runs may emit pokes

  console.log(
    `# Committed cold-start trigger — mode=${COMMIT ? "COMMIT" : "DRY"} | targets=${TARGET_EMAILS.join(", ")}`,
  );

  const users = await db()
    .select({ userId: userTable.id, email: userTable.email })
    .from(userTable)
    .where(inArray(userTable.email, TARGET_EMAILS));

  const found = new Set(users.map((u) => u.email));

  for (const email of TARGET_EMAILS) {
    if (!found.has(email)) console.log(`! no user row for ${email} — skipping`);
  }

  for (const u of users) await processUser(u);

  console.log("\n# done");
}

main()
  .catch((e) => {
    // Message only: a serialized Error can leak DATABASE_URL.
    console.error(toMessage(e));
    process.exitCode = 1;
  })
  .finally(async () => {
    // Close the queue so enqueued jobs are persisted before exit.
    await closeScriptResources(closeAgentQueue);
  });
