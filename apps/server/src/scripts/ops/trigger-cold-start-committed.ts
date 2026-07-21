/**
 * COMMITTED cold-start trigger (one-off, 2026-06-12).
 *
 * Fires the v2 `cold-start-research` workflow for a target user whose original
 * signup cold-start never produced data (the v1 Sonar path died with the
 * Perplexity billing). Enqueues a real run onto the SAME BullMQ queue the prod
 * `server` worker consumes, so the boss-seed → parallel web_search aspects →
 * synthesis → extract → persist pipeline executes in the worker exactly as a
 * signup would. Bundled by tsdown (`noExternal: @alfred/*`) so it runs on prod
 * with plain `node dist/scripts/ops/trigger-cold-start-committed.js` — the prod
 * image has no `tsx`/loose `@alfred/*` sources.
 *
 * Lifetime-once is enforced by the partial unique index on
 * `agent_runs.dedup_key`; failed/cancelled rows are excluded, so a dead v1 run
 * doesn't block this. We still cancel any *active* prior cold-start run first so
 * a re-invocation (or a stuck row) can't trip `23505`.
 *
 * SAFETY: dry by default. Pass `--commit` to actually cancel-prior + enqueue.
 *
 *   # preview (writes nothing):
 *   node dist/scripts/ops/trigger-cold-start-committed.js
 *   # commit:
 *   node dist/scripts/ops/trigger-cold-start-committed.js --commit
 *   # override target(s):
 *   COLD_START_EMAILS="a@x.com,b@y.com" node dist/scripts/ops/trigger-cold-start-committed.js --commit
 */
import { COLD_START_WORKFLOW_SLUG, createRun, enqueueRun } from "@alfred/api/backend";
import { closeAgentQueue, warmPool } from "@alfred/api/runtime";
import { db } from "@alfred/db";
import { agentRuns, user as userTable } from "@alfred/db/schemas";
import { and, eq, inArray, sql } from "drizzle-orm";
import { registerBuiltinWorkflows } from "~/builtins";
import { toMessage } from "@alfred/contracts";
import { closeScriptResources } from "../script-runtime";

/** Mailboxes to (re-)research. Override with `COLD_START_EMAILS` (comma-sep). */
const TARGET_EMAILS = (process.env.COLD_START_EMAILS ?? "yashgouravkar@gmail.com")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);

const COMMIT = process.argv.includes("--commit");

async function processUser(u: { userId: string; email: string }): Promise<void> {
  console.log(`\n=== ${u.email} (user=${u.userId}) ===`);

  // Inspect any prior cold-start runs so the preview is informative.
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

  // Clear any ACTIVE prior run so the partial unique index admits the insert.
  // (Failed/cancelled rows are already excluded from the index.)
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

  const { runId } = await createRun({
    userId: u.userId,
    workflowSlug: COLD_START_WORKFLOW_SLUG,
    input: { reason: "manual" },
    metadata: { source: "trigger-cold-start-committed-2026-06-12" },
    trigger: { kind: "manual" },
  });
  await enqueueRun(runId);
  console.log(`  enqueued cold-start run ${runId} (worker executes it)`);
}

async function main() {
  await warmPool();
  registerBuiltinWorkflows(); // createRun resolves builtins from the in-process registry

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
    // Log only the message — a serialized Error can leak DATABASE_URL.
    console.error(toMessage(e));
    process.exitCode = 1;
  })
  .finally(async () => {
    // Flush + close so enqueued BullMQ jobs are durably persisted before exit.
    await closeScriptResources(closeAgentQueue);
  });
