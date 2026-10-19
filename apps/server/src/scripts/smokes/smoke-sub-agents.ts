/**
 * Smoke test for sub-agent spawn, without running the child: one child run, parent
 * metadata stamped, nested spawns blocked, child scratch writes in the parent's namespace.
 *
 *   $ pnpm --filter server tsx --env-file=.env src/scripts/smokes/smoke-sub-agents.ts
 */

import { randomUUID } from "node:crypto";
import { activateWorkflow, createWorkflowDraft } from "@alfred/assistant/automation";
import { dispatchToolCall } from "@alfred/assistant/tool-runtime/dispatch";
import { scratchpad, startRun, closeAgentQueue } from "@alfred/assistant/execution";
import { SUB_AGENT_WORKFLOW_SLUG } from "@alfred/assistant/execution/sub-agent-metadata";
import { closeConnections, warmPool } from "@alfred/db";
import { closeRedis } from "@alfred/db/redis";
import { registerAgentSystemToolAdapter } from "@alfred/assistant/execution/system-tool-adapter";

import { registerBuiltinTools } from "@alfred/assistant/tool-runtime/builtin-tools";
import { registerChatSystemToolAdapter } from "@alfred/assistant/chat";
import { registerReplicachePokeAdapter } from "@alfred/assistant/realtime";
import { getPath, isRecord } from "@alfred/contracts";
import { db } from "@alfred/db";
import {
  actionStagings,
  agentRuns,
  user as userTable,
  workflowRevisions,
  workflows,
} from "@alfred/db/schemas";
import { and, eq, sql } from "drizzle-orm";
import { registerBuiltinWorkflows } from "~/builtins";

const SMOKE_USER_EMAIL = "smoke-sub-agents@alfred.local";

const WORKFLOW_SLUG = "smoke-sub-agents";

const SUB_AGENT_BRIEF = "Find the important recent Gmail threads and summarize them.";

async function findOrCreateSmokeUser(): Promise<string> {
  const existing = await db().select().from(userTable).where(eq(userTable.email, SMOKE_USER_EMAIL));

  if (existing[0]) return existing[0].id;

  const inserted = await db()
    .insert(userTable)
    .values({ name: "Sub-agent Smoke", email: SMOKE_USER_EMAIL, emailVerified: true })
    .returning({ id: userTable.id });

  if (!inserted[0]) throw new Error("failed to insert smoke user");

  return inserted[0].id;
}

/** Runs go first: a run pins its revision, and the workflow delete cascades to its revisions. */
async function resetSmokeRows(userId: string): Promise<void> {
  // The smoke user is dedicated, so this also removes the spawned child runs.
  await db().delete(agentRuns).where(eq(agentRuns.userId, userId));
  await db()
    .delete(workflows)
    .where(and(eq(workflows.userId, userId), eq(workflows.slug, WORKFLOW_SLUG)));

  const leftover = await db()
    .select({ id: workflowRevisions.id })
    .from(workflowRevisions)
    .where(eq(workflowRevisions.userId, userId));

  if (leftover.length > 0) {
    throw new Error(`[smoke-sub-agents] ${leftover.length} workflow revision rows survived reset`);
  }
}

/** `startRun` resolves an authored slug only through an approved, published revision. */
async function createSmokeWorkflow(userId: string): Promise<void> {
  const draft = await createWorkflowDraft({
    userId,
    slug: WORKFLOW_SLUG,
    definition: {
      name: "Smoke sub-agents",
      description: null,
      brief: "Spawn a sub-agent when a subtask needs its own investigation.",
      trigger: { kind: "manual" },
      allowedIntegrations: ["system"],
      allowedTools: ["system.spawn_sub_agent", "system.write_scratch"],
      requiredCapabilities: [{ tool: "system.spawn_sub_agent" }, { tool: "system.write_scratch" }],
    },
  });

  if (!draft.ok) {
    throw new Error(`[smoke-sub-agents] draft failed: ${JSON.stringify(draft.failure)}`);
  }

  const activated = await activateWorkflow({
    userId,
    workflowId: draft.workflow.id,
    expectedRowVersion: draft.workflow.rowVersion,
  });

  if (!activated.ok) {
    throw new Error(`[smoke-sub-agents] activation failed: ${JSON.stringify(activated.failure)}`);
  }
}

function assertObject(value: unknown, label: string): asserts value is Record<string, unknown> {
  if (!isRecord(value)) {
    throw new Error(`[smoke-sub-agents] ${label} is not an object`);
  }
}

async function main(): Promise<void> {
  await warmPool();
  // A spawned child runs the registered brief workflow, so `createRun` must resolve it here.
  registerBuiltinWorkflows();
  registerBuiltinTools();
  // Install the same adapters the server boot installs, or the calls throw.
  registerAgentSystemToolAdapter();
  registerChatSystemToolAdapter();
  registerReplicachePokeAdapter();

  const userId = await findOrCreateSmokeUser();
  await resetSmokeRows(userId);
  await createSmokeWorkflow(userId);

  // `startRun` also enqueues the parent. The smoke drives it by hand, so that job is inert.
  const parent = await startRun({
    userId,
    workflowSlug: WORKFLOW_SLUG,
    trigger: { kind: "manual" },
    occurrence: { kind: "manual", requestId: randomUUID() },
  });

  console.log(`[smoke-sub-agents] user=${userId} parent=${parent.runId}`);

  const spawned = await dispatchToolCall({
    runId: parent.runId,
    stepId: "dispatch-tools",
    toolCallId: "tc_spawn_sub_a",
    toolName: "system.spawn_sub_agent",
    activeTools: ["system.spawn_sub_agent"],
    input: {
      subId: "subA",
      brief: SUB_AGENT_BRIEF,
      allowedIntegrations: ["gmail"],
    },
    userId,
    caller: "boss",
    runContext: { caller: "boss", interaction: "background" },
    fence: { generation: 0 },
    allowedIntegrations: ["gmail"],
  });

  if (spawned.kind !== "executed") {
    throw new Error(`[smoke-sub-agents] spawn expected executed, got ${spawned.kind}`);
  }

  assertObject(spawned.toolResult, "spawn result");

  if (spawned.toolResult.ok !== true || typeof spawned.toolResult.childRunId !== "string") {
    throw new Error("[smoke-sub-agents] spawn result missing childRunId");
  }

  const childRunId = spawned.toolResult.childRunId;

  const childRows = await db().select().from(agentRuns).where(eq(agentRuns.id, childRunId));
  const child = childRows[0];

  if (!child) throw new Error("[smoke-sub-agents] child run row not found");

  // A child never runs the parent's slug: it starts from a bare brief on the sub-agent workflow.
  if (child.workflowSlug !== SUB_AGENT_WORKFLOW_SLUG || child.brief !== SUB_AGENT_BRIEF) {
    throw new Error("[smoke-sub-agents] child run is not a sub-agent brief run");
  }

  assertObject(child.metadata, "child metadata");
  assertObject(child.metadata.subAgent, "child subAgent metadata");

  if (
    child.metadata.subAgent.parentRunId !== parent.runId ||
    child.metadata.subAgent.subId !== "subA" ||
    child.metadata.subAgent.parentToolCallId !== "tc_spawn_sub_a"
  ) {
    throw new Error("[smoke-sub-agents] child metadata does not link back to parent call");
  }

  if (child.transcript[0]?.role !== "user" || child.transcript[0].content !== child.brief) {
    throw new Error("[smoke-sub-agents] child transcript was not seeded from the sub-agent brief");
  }

  console.log(`[smoke-sub-agents] spawn created child=${childRunId}`);

  const redispatched = await dispatchToolCall({
    runId: parent.runId,
    stepId: "dispatch-tools",
    toolCallId: "tc_spawn_sub_a",
    toolName: "system.spawn_sub_agent",
    activeTools: ["system.spawn_sub_agent"],
    input: {
      subId: "subA",
      brief: "This payload should not create a second child.",
      allowedIntegrations: ["gmail"],
    },
    userId,
    caller: "boss",
    runContext: { caller: "boss", interaction: "background" },
    fence: { generation: 0 },
    allowedIntegrations: ["gmail"],
  });

  if (redispatched.kind !== "executed") {
    throw new Error(`[smoke-sub-agents] redispatch expected executed, got ${redispatched.kind}`);
  }

  const countRows = await db()
    .select({ count: sql<number>`count(*)::int` })
    .from(agentRuns)
    .where(
      and(
        eq(agentRuns.userId, userId),
        sql`${agentRuns.metadata}->'subAgent'->>'parentRunId' = ${parent.runId}`,
        sql`${agentRuns.metadata}->'subAgent'->>'parentToolCallId' = 'tc_spawn_sub_a'`,
      ),
    );

  if (countRows[0]?.count !== 1) {
    throw new Error(
      `[smoke-sub-agents] expected one child after redispatch, got ${countRows[0]?.count}`,
    );
  }

  console.log("[smoke-sub-agents] spawn redispatch is idempotent");

  const nested = await dispatchToolCall({
    runId: childRunId,
    stepId: "dispatch-tools",
    toolCallId: "tc_nested_spawn",
    toolName: "system.spawn_sub_agent",
    activeTools: ["system.spawn_sub_agent"],
    input: { subId: "subB", brief: "Nested spawn should be rejected.", allowedIntegrations: [] },
    userId,
    caller: { subId: "subA" },
    runContext: { caller: "sub_agent", interaction: "background" },
    fence: { generation: 0 },
    scratchpadRunId: parent.runId,
    allowedIntegrations: ["gmail"],
  });

  // The tool is boss-only, so the availability floor refuses a sub-agent caller before input checks.
  if (nested.kind !== "not_allowed" || nested.unavailability !== "wrong_caller") {
    throw new Error(
      `[smoke-sub-agents] nested spawn expected not_allowed/wrong_caller, got ${nested.kind}`,
    );
  }

  console.log("[smoke-sub-agents] nested spawn blocked");

  const childScratchWrite = await dispatchToolCall({
    runId: childRunId,
    stepId: "dispatch-tools",
    toolCallId: "tc_child_write",
    toolName: "system.write_scratch",
    activeTools: ["system.write_scratch"],
    input: { key: "scratch.subA.findings", value: { threads: 3 } },
    userId,
    caller: { subId: "subA" },
    runContext: { caller: "sub_agent", interaction: "background" },
    fence: { generation: 0 },
    scratchpadRunId: parent.runId,
    allowedIntegrations: ["gmail"],
  });

  if (childScratchWrite.kind !== "executed") {
    throw new Error(
      `[smoke-sub-agents] child scratch write expected executed, got ${childScratchWrite.kind}`,
    );
  }

  const parentScratch = await scratchpad({ runId: parent.runId, writer: "boss" }).read(
    "scratch.subA.findings",
  );

  if (
    !parentScratch ||
    getPath(parentScratch.value, "threads") !== 3 ||
    parentScratch.writtenBy !== "subA"
  ) {
    throw new Error("[smoke-sub-agents] child scratch write did not land on parent run");
  }

  console.log("[smoke-sub-agents] child scratch writes route to parent run");

  const stagedRows = await db()
    .select()
    .from(actionStagings)
    .where(
      and(
        eq(actionStagings.runId, parent.runId),
        eq(actionStagings.toolName, "system.spawn_sub_agent"),
      ),
    );

  if (stagedRows.length !== 1 || stagedRows[0]?.status !== "executed") {
    throw new Error(
      "[smoke-sub-agents] spawn should leave exactly one executed action_stagings row",
    );
  }

  await resetSmokeRows(userId);
  console.log("[smoke-sub-agents] cleanup ok");
}

try {
  await main();
  console.log("[smoke-sub-agents] PASS");
} catch (err) {
  console.error("[smoke-sub-agents] FAIL", err);
  process.exitCode = 1;
} finally {
  await closeAgentQueue();
  await closeRedis();
  await closeConnections();
}
