/**
 * Manual QA: start a run that parks on one gated `gmail.send_draft`, then exit and
 * leave the pending staging for a human at /approvals.
 *
 * Warning: `gmail.send_draft` sends live mail. Approving the card sends the BRIEF email.
 *
 *   $ pnpm --filter server tsx --env-file=.env src/scripts/qa/qa-gated-staging.ts
 */

import { randomUUID } from "node:crypto";
import { startRun, closeAgentQueue } from "@alfred/assistant/execution";
import { registerReplicachePokeAdapter } from "@alfred/assistant/realtime";
import { warmPool } from "@alfred/db";
import { db } from "@alfred/db";
import {
  actionStagings,
  agentRuns,
  integrationCredentials,
  user as userTable,
  userActionPolicies,
  workflows,
} from "@alfred/db/schemas";
import { and, eq } from "drizzle-orm";
import { registerBuiltinWorkflows } from "~/builtins";
import { closeScriptResources } from "../script-runtime";

const WORKFLOW_SLUG = `qa-gated-staging${process.argv[2] ? `-${process.argv[2]}` : ""}`;

const BRIEF =
  "@gmail — Draft a short email to yashgouravkar@gmail.com with the subject 'Alfred approvals QA' and the body 'This is a test of the approvals flow.' Then send the draft to deliver it.";

const POLL_INTERVAL_MS = 500;

const POLL_TIMEOUT_MS = 5 * 60_000;

async function pickGoogleUser(): Promise<{ id: string; email: string } | null> {
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

async function main(): Promise<void> {
  await warmPool();
  registerBuiltinWorkflows();
  registerReplicachePokeAdapter(); // enqueued runs may emit pokes

  const target = await pickGoogleUser();

  if (!target) {
    console.log("[qa-gated-staging] no google-connected user — connect Gmail first.");

    return;
  }

  console.log(`[qa-gated-staging] target: ${target.email} (${target.id})`);

  await db()
    .insert(userActionPolicies)
    .values({ userId: target.id })
    .onConflictDoNothing({ target: userActionPolicies.userId });

  await db()
    .delete(agentRuns)
    .where(and(eq(agentRuns.userId, target.id), eq(agentRuns.workflowSlug, WORKFLOW_SLUG)));
  await db()
    .delete(workflows)
    .where(and(eq(workflows.userId, target.id), eq(workflows.slug, WORKFLOW_SLUG)));

  await db()
    .insert(workflows)
    .values({
      userId: target.id,
      slug: WORKFLOW_SLUG,
      name: "QA gated staging",
      brief: BRIEF,
      trigger: { kind: "manual" },
      allowedIntegrations: ["gmail"],
      status: "active",
      isBuiltin: false,
    });

  const { runId } = await startRun({
    userId: target.id,
    workflowSlug: WORKFLOW_SLUG,
    trigger: { kind: "manual" },
    occurrence: { kind: "manual", requestId: randomUUID() },
  });

  console.log(`[qa-gated-staging] run enqueued: ${runId}`);

  const deadline = Date.now() + POLL_TIMEOUT_MS;
  let lastStep: string | null = null;

  while (Date.now() < deadline) {
    const row = (await db().select().from(agentRuns).where(eq(agentRuns.id, runId)))[0];

    if (!row) throw new Error(`run ${runId} not found`);

    if (row.currentStep !== lastStep) {
      console.log(`[qa-gated-staging]   step → ${row.currentStep} (status=${row.status})`);
      lastStep = row.currentStep;
    }

    if (row.status === "waiting") {
      const pending = await db()
        .select({
          id: actionStagings.id,
          toolName: actionStagings.toolName,
          riskTier: actionStagings.riskTier,
        })
        .from(actionStagings)
        .where(and(eq(actionStagings.runId, runId), eq(actionStagings.status, "pending")));

      if (pending.length > 0) {
        console.log("\n[qa-gated-staging] run is PARKED on a gated approval:");

        for (const p of pending) console.log(`   - ${p.toolName} [${p.riskTier}] staging=${p.id}`);
        console.log(`\n[qa-gated-staging] open http://localhost:3000/approvals to click through.`);
        console.log(`[qa-gated-staging] run id: ${runId}`);

        return;
      }
    }

    if (row.status === "completed" || row.status === "failed" || row.status === "cancelled") {
      console.log(
        `[qa-gated-staging] run reached terminal status=${row.status} WITHOUT a gated stop.`,
      );
      console.log(`[qa-gated-staging] output: ${JSON.stringify(row.output)}`);

      return;
    }

    await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
  }

  throw new Error(`timed out waiting for run ${runId} to park`);
}

try {
  await main();
} catch (err) {
  console.error("[qa-gated-staging] FAIL", err instanceof Error ? (err.stack ?? err.message) : err);
  process.exitCode = 1;
} finally {
  await closeScriptResources(closeAgentQueue);
}
