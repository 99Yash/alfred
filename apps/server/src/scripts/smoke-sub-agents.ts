/**
 * Smoke test for m13 Phase 6 sub-agent spawn plumbing.
 *
 *   $ pnpm --filter server tsx --env-file=.env src/scripts/smoke-sub-agents.ts
 *
 * This does not wait on an LLM-backed child run. It verifies the durable
 * runtime seam: `system.spawn_sub_agent` creates exactly one child run,
 * stamps parent metadata, blocks nested spawns, and routes child scratch
 * writes into the parent run's scratchpad namespace.
 */

import {
  closeAgentQueue,
  closeConnections,
  closeRedis,
  createRun,
  dispatchToolCall,
  readScratch,
  registerBuiltinTools,
  warmPool,
} from "@alfred/api";
import { db } from "@alfred/db";
import { actionStagings, agentRuns, user as userTable, workflows } from "@alfred/db/schemas";
import { and, eq, sql } from "drizzle-orm";

const SMOKE_USER_EMAIL = "smoke-sub-agents@alfred.local";
const WORKFLOW_SLUG = "smoke-sub-agents";
const SUB_AGENT_BRIEF = "Find the important recent Gmail threads and summarize them.";

async function findOrCreateSmokeUser(): Promise<string> {
  const existing = await db()
    .select()
    .from(userTable)
    .where(eq(userTable.email, SMOKE_USER_EMAIL));
  if (existing[0]) return existing[0].id;
  const inserted = await db()
    .insert(userTable)
    .values({ name: "Sub-agent Smoke", email: SMOKE_USER_EMAIL, emailVerified: true })
    .returning({ id: userTable.id });
  if (!inserted[0]) throw new Error("failed to insert smoke user");
  return inserted[0].id;
}

async function resetSmokeRows(userId: string): Promise<void> {
  await db()
    .delete(agentRuns)
    .where(and(eq(agentRuns.userId, userId), eq(agentRuns.workflowSlug, WORKFLOW_SLUG)));
  await db()
    .delete(workflows)
    .where(and(eq(workflows.userId, userId), eq(workflows.slug, WORKFLOW_SLUG)));
}

async function createSmokeWorkflow(userId: string): Promise<void> {
  await db().insert(workflows).values({
    userId,
    slug: WORKFLOW_SLUG,
    name: "Smoke sub-agents",
    brief: "Use @gmail only when needed.",
    trigger: { kind: "manual" },
    allowedIntegrations: ["gmail"],
    status: "active",
    isBuiltin: false,
  });
}

function assertObject(value: unknown, label: string): asserts value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`[smoke-sub-agents] ${label} is not an object`);
  }
}

async function main(): Promise<void> {
  await warmPool();
  registerBuiltinTools();

  const userId = await findOrCreateSmokeUser();
  await resetSmokeRows(userId);
  await createSmokeWorkflow(userId);

  const parent = await createRun({
    userId,
    workflowSlug: WORKFLOW_SLUG,
    trigger: { kind: "manual" },
  });
  console.log(`[smoke-sub-agents] user=${userId} parent=${parent.runId}`);

  const spawned = await dispatchToolCall({
    runId: parent.runId,
    stepId: "dispatch-tools",
    toolCallId: "tc_spawn_sub_a",
    toolName: "system.spawn_sub_agent",
    input: {
      subId: "subA",
      brief: SUB_AGENT_BRIEF,
      allowedIntegrations: ["gmail"],
    },
    userId,
    caller: "boss",
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
  if (child.workflowSlug !== WORKFLOW_SLUG || child.brief !== SUB_AGENT_BRIEF) {
    throw new Error("[smoke-sub-agents] child run did not preserve workflow slug + brief");
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
    input: {
      subId: "subA",
      brief: "This payload should not create a second child.",
      allowedIntegrations: ["gmail"],
    },
    userId,
    caller: "boss",
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
    input: { subId: "subB", brief: "Nested spawn should be rejected.", allowedIntegrations: [] },
    userId,
    caller: { subId: "subA" },
    scratchpadRunId: parent.runId,
    allowedIntegrations: ["gmail"],
  });
  if (nested.kind !== "invalid_input") {
    throw new Error(`[smoke-sub-agents] nested spawn expected invalid_input, got ${nested.kind}`);
  }
  console.log("[smoke-sub-agents] nested spawn blocked");

  const childScratchWrite = await dispatchToolCall({
    runId: childRunId,
    stepId: "dispatch-tools",
    toolCallId: "tc_child_write",
    toolName: "system.write_scratch",
    input: { key: "scratch.subA.findings", value: { threads: 3 } },
    userId,
    caller: { subId: "subA" },
    scratchpadRunId: parent.runId,
    allowedIntegrations: ["gmail"],
  });
  if (childScratchWrite.kind !== "executed") {
    throw new Error(
      `[smoke-sub-agents] child scratch write expected executed, got ${childScratchWrite.kind}`,
    );
  }
  const parentScratch = await readScratch<{ threads: number }>({
    runId: parent.runId,
    zone: "scratch",
    subId: "subA",
    path: "findings",
  });
  if (parentScratch?.value.threads !== 3 || parentScratch.writtenBy !== "subA") {
    throw new Error("[smoke-sub-agents] child scratch write did not land on parent run");
  }
  console.log("[smoke-sub-agents] child scratch writes route to parent run");

  const stagedRows = await db()
    .select()
    .from(actionStagings)
    .where(and(eq(actionStagings.runId, parent.runId), eq(actionStagings.toolName, "system.spawn_sub_agent")));
  if (stagedRows.length !== 1 || stagedRows[0]?.status !== "executed") {
    throw new Error("[smoke-sub-agents] spawn should leave exactly one executed action_stagings row");
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
