/**
 * End-to-end boss smoke with the model in the loop: search, spawn a sub-agent,
 * promote its findings, and send a gated draft.
 *
 *   $ pnpm --filter server tsx --env-file=.env src/scripts/smokes/smoke-boss.ts
 *
 * Pre-reqs:
 *   - A server process running (`pnpm dev`), so the worker runs the run and its child.
 *     This script auto-approves pending stagings.
 *   - One user with Google connected (gmail.send scope).
 *
 * Gmail runs on autonomy with `gmail.send_draft` gated, so one run covers both
 * dispatch paths. The user's real policy row is restored in `finally`.
 */

import { randomUUID } from "node:crypto";
import { redeliverRun, signalRun, startRun, closeAgentQueue } from "@alfred/assistant/execution";
import { warmPool } from "@alfred/db";
import { GOOGLE_SCOPE, getStringPath } from "@alfred/contracts";
import { db } from "@alfred/db";
import {
  actionStagings,
  agentRunContext,
  agentRuns,
  documents,
  integrationCredentials,
  userActionPolicies,
  user as userTable,
  workflows,
  type UserActionPolicy,
} from "@alfred/db/schemas";
import { and, desc, eq, inArray, like, sql } from "drizzle-orm";
import { registerBuiltinWorkflows } from "~/builtins";
import { closeScriptResources } from "../script-runtime";

const WORKFLOW_SLUG = "smoke-boss";

const POLL_INTERVAL_MS = 2_000;

// Boss plus a sub-agent is many model turns, so allow hours. The policy is restored only after this.
const POLL_TIMEOUT_MS = 3 * 60 * 60_000;

function assert(cond: unknown, msg: string): asserts cond {
  if (!cond) throw new Error(`[smoke-boss] assertion failed: ${msg}`);
}

async function pickGoogleConnectedUser(): Promise<{
  id: string;
  email: string;
} | null> {
  const rows = await db()
    .select({ id: userTable.id, email: userTable.email })
    .from(userTable)
    .innerJoin(integrationCredentials, eq(integrationCredentials.userId, userTable.id))
    .where(
      and(
        eq(integrationCredentials.provider, "google"),
        eq(integrationCredentials.status, "active"),
        sql`${integrationCredentials.scopes} ? ${GOOGLE_SCOPE.gmail.send}`,
      ),
    )
    .limit(1);

  return rows[0] ?? null;
}

type PolicyRow = UserActionPolicy;

/** Install the smoke policy and return the old policy row (or null) for restore. */
async function installSmokePolicy(userId: string): Promise<PolicyRow | null> {
  const existing = await db()
    .select()
    .from(userActionPolicies)
    .where(eq(userActionPolicies.userId, userId));

  const snapshot = existing[0] ?? null;

  const smokeRules = {
    system: { mode: "autonomy" as const },
    gmail: {
      mode: "autonomy" as const,
      toolOverrides: { "gmail.send_draft": "gated" as const },
    },
  };

  await db()
    .insert(userActionPolicies)
    .values({ userId, defaultMode: "gated", integrationRules: smokeRules })
    .onConflictDoUpdate({
      target: userActionPolicies.userId,
      set: {
        integrationRules: smokeRules,
        rowVersion: sql`${userActionPolicies.rowVersion} + 1`,
      },
    });

  return snapshot;
}

async function restorePolicy(userId: string, snapshot: PolicyRow | null): Promise<void> {
  if (!snapshot) {
    await db().delete(userActionPolicies).where(eq(userActionPolicies.userId, userId));

    return;
  }

  await db()
    .update(userActionPolicies)
    .set({
      defaultMode: snapshot.defaultMode,
      integrationRules: snapshot.integrationRules,
      approvalNotifyDelayMs: snapshot.approvalNotifyDelayMs,
      rowVersion: sql`${userActionPolicies.rowVersion} + 1`,
    })
    .where(eq(userActionPolicies.userId, userId));
}

async function resetSmokeRows(userId: string): Promise<void> {
  await db()
    .delete(agentRuns)
    .where(and(eq(agentRuns.userId, userId), eq(agentRuns.workflowSlug, WORKFLOW_SLUG)));
  await db()
    .delete(workflows)
    .where(and(eq(workflows.userId, userId), eq(workflows.slug, WORKFLOW_SLUG)));
}

async function createSmokeWorkflow(userId: string, selfEmail: string): Promise<void> {
  // `gmail.read_message` reads ingested `documents`, not the Gmail API, so give the brief a real doc id.
  const [doc] = await db()
    .select({ id: documents.id, title: documents.title })
    .from(documents)
    .where(and(eq(documents.userId, userId), eq(documents.source, "gmail")))
    .orderBy(desc(documents.authoredAt))
    .limit(1);

  if (!doc) {
    throw new Error(
      "[smoke-boss] no ingested gmail documents for this user — run gmail ingestion first",
    );
  }

  const brief = [
    "@gmail — This is a delegation smoke test. You are the BOSS and you MUST delegate the",
    "reading work to a sub-agent. Do NOT call gmail.read_message yourself — that is the",
    "sub-agent's job. Follow these steps exactly and in order:",
    "",
    "1. Call gmail.search with q='in:inbox newer_than:7d' to confirm inbox access. (Search only — do not read bodies.)",
    "2. You MUST call system.spawn_sub_agent with subId 'inbox', allowedIntegrations ['gmail'], and",
    "   this EXACT brief for the sub-agent (copy it verbatim):",
    `     "Call gmail.read_message with documentId '${doc.id}', then write a one-sentence summary`,
    '      of that email to the scratch key scratch.inbox.summary."',
    "3. Then call system.read_scratch for 'scratch.inbox.summary'. If it is empty, the sub-agent",
    "   has not finished yet — call system.read_scratch again on your next turn until it returns content.",
    "4. Once you have the finding, call system.promote to copy 'scratch.inbox.summary' to 'shared.summary'.",
    `5. Call gmail.send_draft to ${selfEmail} with subject 'Alfred boss smoke' and the promoted`,
    "   summary as the body. This needs approval — proceed and wait for it.",
    "6. Finish with one sentence confirming you delegated to a sub-agent, promoted its finding, and sent the email.",
  ].join("\n");

  await db()
    .insert(workflows)
    .values({
      userId,
      slug: WORKFLOW_SLUG,
      name: "Smoke boss",
      brief,
      trigger: { kind: "manual" },
      allowedIntegrations: ["gmail"],
      status: "active",
      isBuiltin: false,
    });
}

interface PendingStaging {
  id: string;
  runId: string;
  toolName: string;
}

async function runTreeIds(runId: string): Promise<string[]> {
  const childRows = await db()
    .select({ id: agentRuns.id })
    .from(agentRuns)
    .where(sql`${agentRuns.metadata}->'subAgent'->>'parentRunId' = ${runId}`);

  return [runId, ...childRows.map((r) => r.id)];
}

async function findPendingApprovals(runId: string): Promise<PendingStaging[]> {
  const runIds = await runTreeIds(runId);

  const rows = await db()
    .select({
      id: actionStagings.id,
      runId: actionStagings.runId,
      toolName: actionStagings.toolName,
    })
    .from(actionStagings)
    .where(
      and(
        inArray(actionStagings.runId, runIds),
        eq(actionStagings.status, "pending"),
        eq(actionStagings.requiresApproval, true),
      ),
    );

  return rows;
}

async function autoApprove(staging: PendingStaging): Promise<void> {
  await db()
    .update(actionStagings)
    .set({
      status: "approved",
      decidedAt: new Date(),
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
  await redeliverRun(staging.runId);
  console.log(`[smoke-boss]   auto-approved ${staging.toolName} (${staging.id})`);
}

async function pollAndAutoApprove(runId: string): Promise<{ status: string; output: unknown }> {
  const deadline = Date.now() + POLL_TIMEOUT_MS;
  let lastStep: string | null = null;

  while (Date.now() < deadline) {
    const rows = await db().select().from(agentRuns).where(eq(agentRuns.id, runId));
    const row = rows[0];

    if (!row) throw new Error(`run ${runId} not found`);

    if (row.currentStep !== lastStep) {
      console.log(`[smoke-boss]   step → ${row.currentStep} (status=${row.status})`);
      lastStep = row.currentStep;
    }

    if (row.status === "waiting") {
      for (const p of await findPendingApprovals(runId)) await autoApprove(p);
    }

    if (row.status === "completed" || row.status === "failed" || row.status === "cancelled") {
      return { status: row.status, output: row.output };
    }

    await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
  }

  throw new Error(`timed out waiting for run ${runId}`);
}

interface StagingSummary {
  runId: string;
  toolName: string;
  status: string;
  requiresApproval: boolean;
}

async function loadStagingsForRun(runId: string): Promise<StagingSummary[]> {
  const runIds = await runTreeIds(runId);

  return db()
    .select({
      runId: actionStagings.runId,
      toolName: actionStagings.toolName,
      status: actionStagings.status,
      requiresApproval: actionStagings.requiresApproval,
    })
    .from(actionStagings)
    .where(inArray(actionStagings.runId, runIds));
}

async function main(): Promise<void> {
  await warmPool();
  registerBuiltinWorkflows();

  const target = await pickGoogleConnectedUser();

  if (!target) {
    console.log(
      "[smoke-boss] no user with an active google credential carrying gmail.send — reconnect Gmail with reply_draft first.",
    );

    return;
  }

  console.log(`[smoke-boss] target: ${target.email} (id=${target.id})`);

  const snapshot = await installSmokePolicy(target.id);

  try {
    await resetSmokeRows(target.id);
    await createSmokeWorkflow(target.id, target.email);

    const { runId } = await startRun({
      userId: target.id,
      workflowSlug: WORKFLOW_SLUG,
      trigger: { kind: "manual" },
      occurrence: { kind: "manual", requestId: randomUUID() },
    });

    console.log(`[smoke-boss] run enqueued: ${runId}`);

    const final = await pollAndAutoApprove(runId);
    assert(
      final.status === "completed",
      `run did not complete: status=${final.status} output=${JSON.stringify(final.output)}`,
    );

    const stagings = await loadStagingsForRun(runId);
    console.log(`[smoke-boss] action_stagings rows: ${stagings.length}`);

    for (const s of stagings) {
      console.log(`   - ${s.toolName} status=${s.status} requiresApproval=${s.requiresApproval}`);
    }

    // 1. gmail.search executed via autonomy (no approval needed).
    const search = stagings.find((s) => s.toolName === "gmail.search");
    assert(search !== undefined, "expected a gmail.search staging");
    assert(
      search.status === "executed" && search.requiresApproval === false,
      `expected gmail.search executed via autonomy, got status=${search?.status} requiresApproval=${search?.requiresApproval}`,
    );

    // 2. The boss spawned a sub-agent → a child run row exists.
    const spawn = stagings.find((s) => s.toolName === "system.spawn_sub_agent");
    assert(
      spawn !== undefined && spawn.status === "executed",
      `expected an executed system.spawn_sub_agent staging, got ${JSON.stringify(spawn)}`,
    );

    const childRows = await db()
      .select({ count: sql<number>`count(*)::int` })
      .from(agentRuns)
      .where(
        and(
          eq(agentRuns.userId, target.id),
          sql`${agentRuns.metadata}->'subAgent'->>'parentRunId' = ${runId}`,
        ),
      );

    assert((childRows[0]?.count ?? 0) >= 1, "expected ≥1 sub-agent child run for the boss run");

    // 3. Terminal scratchpad snapshot mirrors both zones into agent_run_context.
    const ctxRows = await db()
      .select({ key: agentRunContext.key, zone: agentRunContext.zone })
      .from(agentRunContext)
      .where(eq(agentRunContext.runId, runId));

    console.log(`[smoke-boss] agent_run_context keys: ${ctxRows.map((r) => r.key).join(", ")}`);
    assert(
      ctxRows.some((r) => r.zone === "scratch"),
      "expected ≥1 scratch.* key in agent_run_context (sub-agent finding)",
    );
    assert(
      ctxRows.some((r) => r.zone === "shared"),
      "expected ≥1 shared.* key in agent_run_context (boss promote)",
    );

    // 4. gmail.send_draft gated → approved → real send executed.
    const sendDraft = stagings.find((s) => s.toolName === "gmail.send_draft");
    assert(sendDraft !== undefined, "expected a gmail.send_draft staging");
    assert(
      sendDraft.requiresApproval === true,
      "expected gmail.send_draft to be gated (requiresApproval=true)",
    );
    assert(
      sendDraft.status === "executed",
      `expected gmail.send_draft to execute after approval, got status=${sendDraft.status}`,
    );

    // 5. No compactor_failed runs for this user.
    const compactorFailed = await db()
      .select({ count: sql<number>`count(*)::int` })
      .from(agentRuns)
      .where(
        and(
          eq(agentRuns.userId, target.id),
          like(sql`${agentRuns.error}::text`, "%compactor_failed%"),
        ),
      );

    assert(
      (compactorFailed[0]?.count ?? 0) === 0,
      "expected no compactor_failed runs for this user",
    );

    const outputText = getStringPath(final.output, "text") ?? null;
    console.log(`[smoke-boss] output.text:\n${outputText}`);

    console.log("\n[smoke-boss] PASS");
  } finally {
    await restorePolicy(target.id, snapshot);
    console.log("[smoke-boss] restored original action policy");
  }
}

try {
  await main();
} catch (err) {
  console.error("[smoke-boss] FAIL", err instanceof Error ? (err.stack ?? err.message) : err);
  process.exitCode = 1;
} finally {
  await closeScriptResources(closeAgentQueue);
}
