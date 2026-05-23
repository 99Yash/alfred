/**
 * Smoke test for m13 Phase 2 — scratchpad helpers + tool registry shape.
 *
 *   $ pnpm --filter server tsx --env-file=.env src/scripts/smoke-scratchpad.ts
 *
 * Exercises the Phase 2 acceptance bullets:
 *   1. writeScratch + readScratch round-trip on a real local Redis.
 *   2. promoteScratch copies a sub-agent value into the boss-owned
 *      `shared.*` zone.
 *   3. dispatcher scratch tools enforce boss/sub-agent zones.
 *   4. snapshotScratchToPostgres lands rows in `agent_run_context` and
 *      is idempotent on retry (second call upserts the same shape).
 *
 * The compile-time guards for invalid tool names are verified by `pnpm check-types`; the file
 * `smoke-tools-types.ts` ships an `@ts-expect-error` assertion that
 * fails compilation if `ToolName` ever stops narrowing properly.
 */

import {
  closeConnections,
  closeRedis,
  dispatchToolCall,
  promoteScratch,
  readScratch,
  registerBuiltinTools,
  snapshotScratchToPostgres,
  warmPool,
  writeScratch,
} from "@alfred/api";
import { db } from "@alfred/db";
import {
  actionStagings,
  agentRunContext,
  agentRuns,
  user as userTable,
} from "@alfred/db/schemas";
import { createRedisConnection } from "@alfred/api/queue/connection";
import { and, eq } from "drizzle-orm";

const SMOKE_USER_EMAIL = "smoke-scratchpad@alfred.local";

async function findOrCreateSmokeUser(): Promise<string> {
  const existing = await db()
    .select()
    .from(userTable)
    .where(eq(userTable.email, SMOKE_USER_EMAIL));
  if (existing[0]) return existing[0].id;
  const inserted = await db()
    .insert(userTable)
    .values({ name: "Scratchpad Smoke", email: SMOKE_USER_EMAIL, emailVerified: true })
    .returning({ id: userTable.id });
  if (!inserted[0]) throw new Error("failed to insert smoke user");
  return inserted[0].id;
}

async function createSmokeRun(userId: string): Promise<string> {
  // Minimal run row purely to satisfy the FK on agent_run_context.
  const inserted = await db()
    .insert(agentRuns)
    .values({
      userId,
      workflowSlug: "smoke-scratchpad",
      currentStep: "snapshot",
      status: "running",
      trigger: { kind: "manual" },
    })
    .returning({ id: agentRuns.id });
  if (!inserted[0]) throw new Error("failed to insert smoke run");
  return inserted[0].id;
}

function deepEqual(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

async function main(): Promise<void> {
  await warmPool();
  registerBuiltinTools();

  const userId = await findOrCreateSmokeUser();
  const runId = await createSmokeRun(userId);
  console.log(`[smoke-scratchpad] user=${userId} run=${runId}`);

  // 1. Round-trip on both zones.
  await writeScratch({
    runId,
    zone: "scratch",
    subId: "subA",
    path: "findings",
    value: { topic: "inbox-debt", count: 42 },
    writtenBy: "subA",
  });
  const subRead = await readScratch<{ topic: string; count: number }>({
    runId,
    zone: "scratch",
    subId: "subA",
    path: "findings",
  });
  if (!subRead || subRead.value.topic !== "inbox-debt" || subRead.value.count !== 42) {
    throw new Error("[smoke-scratchpad] sub-agent round-trip failed");
  }
  console.log("[smoke-scratchpad] round-trip ok (scratch.subA.findings)");

  await writeScratch({
    runId,
    zone: "shared",
    path: "goal",
    value: "answer inbox by EOD",
    writtenBy: "boss",
  });
  const sharedRead = await readScratch<string>({ runId, zone: "shared", path: "goal" });
  if (sharedRead?.value !== "answer inbox by EOD") {
    throw new Error("[smoke-scratchpad] shared round-trip failed");
  }
  console.log("[smoke-scratchpad] round-trip ok (shared.goal)");

  // 2. Promote.
  const promoted = await promoteScratch({
    runId,
    fromSubId: "subA",
    fromPath: "findings",
    toSharedPath: "findings",
  });
  if (!promoted || !deepEqual(promoted.value, { topic: "inbox-debt", count: 42 })) {
    throw new Error("[smoke-scratchpad] promote failed");
  }
  const promotedRead = await readScratch<{ topic: string; count: number }>({
    runId,
    zone: "shared",
    path: "findings",
  });
  if (promotedRead?.writtenBy !== "boss") {
    throw new Error("[smoke-scratchpad] promoted entry lost writtenBy='boss'");
  }
  console.log("[smoke-scratchpad] promote ok (scratch.subA.findings → shared.findings)");

  // 3. Dispatcher-enforced scratchpad tools.
  const bossWrite = await dispatchToolCall({
    runId,
    stepId: "scratch-tools",
    toolCallId: "tc_boss_write_shared",
    toolName: "system.write_scratch",
    input: { key: "shared.dispatch", value: { ok: true } },
    userId,
    caller: "boss",
  });
  if (bossWrite.kind !== "executed") {
    throw new Error(`[smoke-scratchpad] boss shared write expected executed, got ${bossWrite.kind}`);
  }
  const dispatchShared = await readScratch<{ ok: boolean }>({
    runId,
    zone: "shared",
    path: "dispatch",
  });
  if (dispatchShared?.value.ok !== true || dispatchShared.writtenBy !== "boss") {
    throw new Error("[smoke-scratchpad] boss shared write did not land");
  }

  const subWrite = await dispatchToolCall({
    runId,
    stepId: "scratch-tools",
    toolCallId: "tc_sub_write_own",
    toolName: "system.write_scratch",
    input: { key: "scratch.subA.dispatch", value: "sub-owned" },
    userId,
    caller: { subId: "subA" },
  });
  if (subWrite.kind !== "executed") {
    throw new Error(`[smoke-scratchpad] sub own write expected executed, got ${subWrite.kind}`);
  }
  const dispatchSub = await readScratch<string>({
    runId,
    zone: "scratch",
    subId: "subA",
    path: "dispatch",
  });
  if (dispatchSub?.value !== "sub-owned" || dispatchSub.writtenBy !== "subA") {
    throw new Error("[smoke-scratchpad] sub-agent own scratch write did not land");
  }

  const subSharedWrite = await dispatchToolCall({
    runId,
    stepId: "scratch-tools",
    toolCallId: "tc_sub_write_shared_blocked",
    toolName: "system.write_scratch",
    input: { key: "shared.blocked", value: "no" },
    userId,
    caller: { subId: "subA" },
  });
  if (subSharedWrite.kind !== "invalid_input") {
    throw new Error(
      `[smoke-scratchpad] sub shared write expected invalid_input, got ${subSharedWrite.kind}`,
    );
  }

  const bossScratchWrite = await dispatchToolCall({
    runId,
    stepId: "scratch-tools",
    toolCallId: "tc_boss_write_scratch_blocked",
    toolName: "system.write_scratch",
    input: { key: "scratch.subA.blocked", value: "no" },
    userId,
    caller: "boss",
  });
  if (bossScratchWrite.kind !== "invalid_input") {
    throw new Error(
      `[smoke-scratchpad] boss scratch write expected invalid_input, got ${bossScratchWrite.kind}`,
    );
  }

  const subOtherRead = await dispatchToolCall({
    runId,
    stepId: "scratch-tools",
    toolCallId: "tc_sub_read_other_blocked",
    toolName: "system.read_scratch",
    input: { key: "scratch.subB.findings" },
    userId,
    caller: { subId: "subA" },
  });
  if (subOtherRead.kind !== "invalid_input") {
    throw new Error(
      `[smoke-scratchpad] sub other read expected invalid_input, got ${subOtherRead.kind}`,
    );
  }

  const promotedByDispatch = await dispatchToolCall({
    runId,
    stepId: "scratch-tools",
    toolCallId: "tc_boss_promote",
    toolName: "system.promote",
    input: { fromKey: "scratch.subA.dispatch", toKey: "shared.dispatch_promoted" },
    userId,
    caller: "boss",
  });
  if (promotedByDispatch.kind !== "executed") {
    throw new Error(
      `[smoke-scratchpad] boss promote expected executed, got ${promotedByDispatch.kind}`,
    );
  }
  const dispatchPromoted = await readScratch<string>({
    runId,
    zone: "shared",
    path: "dispatch_promoted",
  });
  if (dispatchPromoted?.value !== "sub-owned") {
    throw new Error("[smoke-scratchpad] dispatcher promote did not copy the sub-agent value");
  }
  const scratchToolRows = await db()
    .select()
    .from(actionStagings)
    .where(and(eq(actionStagings.runId, runId), eq(actionStagings.stepId, "scratch-tools")));
  if (scratchToolRows.length !== 0) {
    throw new Error(
      `[smoke-scratchpad] scratch tools should skip action_stagings, got ${scratchToolRows.length}`,
    );
  }
  console.log("[smoke-scratchpad] dispatcher scratch tools + zone enforcement ok");

  // 4. Snapshot to Postgres + idempotency check.
  const firstCount = await snapshotScratchToPostgres(runId);
  if (firstCount !== 6) {
    throw new Error(`[smoke-scratchpad] expected 6 snapshot rows, got ${firstCount}`);
  }
  const firstRows = await db()
    .select()
    .from(agentRunContext)
    .where(eq(agentRunContext.runId, runId));
  const firstKeys = new Set(firstRows.map((r) => r.key));
  for (const expected of [
    "scratch.subA.findings",
    "scratch.subA.dispatch",
    "shared.goal",
    "shared.findings",
    "shared.dispatch",
    "shared.dispatch_promoted",
  ]) {
    if (!firstKeys.has(expected)) {
      throw new Error(`[smoke-scratchpad] missing snapshot key: ${expected}`);
    }
  }
  console.log(`[smoke-scratchpad] first snapshot ok (${firstCount} rows)`);

  const secondCount = await snapshotScratchToPostgres(runId);
  if (secondCount !== firstCount) {
    throw new Error(
      `[smoke-scratchpad] snapshot not idempotent: first=${firstCount} second=${secondCount}`,
    );
  }
  const secondRows = await db()
    .select()
    .from(agentRunContext)
    .where(eq(agentRunContext.runId, runId));
  if (secondRows.length !== firstRows.length) {
    throw new Error(
      `[smoke-scratchpad] row count drift: first=${firstRows.length} second=${secondRows.length}`,
    );
  }
  console.log(`[smoke-scratchpad] second snapshot idempotent (${secondCount} rows, same shape)`);

  // Cleanup: scratchpad keys (best-effort), then DB rows. SCAN+DEL
  // instead of KEYS so the script stays safe if it ever points at a
  // non-trivial Redis.
  const conn = createRedisConnection();
  try {
    const match = `alfred:scratch:${runId}:*`;
    let cursor = "0";
    do {
      const [next, batch] = await conn.scan(cursor, "MATCH", match, "COUNT", 100);
      cursor = next;
      if (batch.length > 0) await conn.del(...batch);
    } while (cursor !== "0");
  } finally {
    await conn.quit().catch(() => conn.disconnect());
  }
  await db()
    .delete(agentRunContext)
    .where(eq(agentRunContext.runId, runId));
  await db().delete(actionStagings).where(eq(actionStagings.runId, runId));
  await db()
    .delete(agentRuns)
    .where(and(eq(agentRuns.id, runId), eq(agentRuns.userId, userId)));
  console.log("[smoke-scratchpad] cleanup ok");
}

try {
  await main();
  console.log("[smoke-scratchpad] PASS");
} catch (err) {
  console.error("[smoke-scratchpad] FAIL", err);
  process.exitCode = 1;
} finally {
  await closeRedis();
  await closeConnections();
}
