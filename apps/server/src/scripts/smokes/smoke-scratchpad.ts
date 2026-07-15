/**
 * Smoke test for m13 Phase 2 — scratchpad helpers + tool registry shape.
 *
 *   $ pnpm --filter server tsx --env-file=.env src/scripts/smokes/smoke-scratchpad.ts
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
  _setScratchRuntimeSpanStarterForTests,
  dispatchToolCall,
  promoteScratch,
  readScratch,
  RUNTIME_SCRATCH_PROMOTE,
  RUNTIME_SCRATCH_READ,
  RUNTIME_SCRATCH_SNAPSHOT,
  RUNTIME_SCRATCH_WRITE,
  snapshotScratchToPostgres,
  writeScratch,
} from "@alfred/api/backend";
import type { RuntimeSpanEndArgs, RuntimeSpanInput } from "@alfred/ai";
import { closeConnections, closeRedis, registerBuiltinTools, warmPool } from "@alfred/api/runtime";
import { db } from "@alfred/db";
import { actionStagings, agentRunContext, agentRuns, user as userTable } from "@alfred/db/schemas";
import { createRedisConnection } from "@alfred/api/queue/connection";
import { and, eq } from "drizzle-orm";

/**
 * Captured scratch health spans (#408). The injected starter records the opening
 * input and the terminal end args so the smoke can assert the runtime-span
 * contract — stable names + safe (hashed, count-only) metadata — alongside the
 * real Redis/Postgres behavior, without a live Langfuse client.
 */
interface CapturedScratchSpan {
  input: RuntimeSpanInput;
  end?: RuntimeSpanEndArgs;
}

/** Assert no captured span leaked a raw scratch value or an un-hashed key/path. */
function assertNoRawLeak(spans: CapturedScratchSpan[]): void {
  const forbidden = ["inbox-debt", "answer inbox by EOD", "sub-owned", "findings", "goal"];
  for (const span of spans) {
    const serialized = JSON.stringify({ metadata: span.input.metadata, end: span.end?.metadata });
    for (const needle of forbidden) {
      if (serialized.includes(needle)) {
        throw new Error(
          `[smoke-scratchpad] health span leaked raw scratch content "${needle}": ${serialized}`,
        );
      }
    }
  }
}

const SMOKE_USER_EMAIL = "smoke-scratchpad@alfred.local";

async function findOrCreateSmokeUser(): Promise<string> {
  const existing = await db().select().from(userTable).where(eq(userTable.email, SMOKE_USER_EMAIL));
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

  // Capture every scratch health span emitted below so we can assert the
  // runtime-span contract end-to-end alongside the real behavior (#408).
  const capturedSpans: CapturedScratchSpan[] = [];
  const restoreSpanCapture = _setScratchRuntimeSpanStarterForTests((input) => {
    const record: CapturedScratchSpan = { input };
    capturedSpans.push(record);
    return {
      end(args) {
        record.end = args;
      },
    };
  });

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
    activeTools: ["system.write_scratch"],
    input: { key: "shared.dispatch", value: { ok: true } },
    userId,
    caller: "boss",
  });
  if (bossWrite.kind !== "executed") {
    throw new Error(
      `[smoke-scratchpad] boss shared write expected executed, got ${bossWrite.kind}`,
    );
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
    activeTools: ["system.write_scratch"],
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
    activeTools: ["system.write_scratch"],
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
    activeTools: ["system.write_scratch"],
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
    activeTools: ["system.read_scratch"],
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
    activeTools: ["system.promote"],
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

  // 5. Health-span contract: every operation above emitted a stable runtime
  //    observation with safe (hashed, count-only) metadata.
  restoreSpanCapture();

  const byName = (name: string): CapturedScratchSpan[] =>
    capturedSpans.filter((s) => s.input.name === name);

  for (const name of [
    RUNTIME_SCRATCH_READ,
    RUNTIME_SCRATCH_WRITE,
    RUNTIME_SCRATCH_PROMOTE,
    RUNTIME_SCRATCH_SNAPSHOT,
  ]) {
    if (byName(name).length === 0) {
      throw new Error(`[smoke-scratchpad] expected at least one ${name} span, got none`);
    }
  }

  // Every span must close with a status and — for keyed ops — carry the hashed
  // key identity by its expected field name. Asserting the hash is *present and
  // sha256-prefixed* is what actually proves the key was fingerprinted rather
  // than emitted raw; `assertNoRawLeak` below covers the raw-value direction.
  const isKeyHash = (v: unknown): boolean => typeof v === "string" && v.startsWith("sha256:");
  for (const span of capturedSpans) {
    if (!span.end?.status) {
      throw new Error(`[smoke-scratchpad] span ${span.input.name} never closed with a status`);
    }
    const meta = span.input.metadata ?? {};
    if (span.input.name === RUNTIME_SCRATCH_READ || span.input.name === RUNTIME_SCRATCH_WRITE) {
      if (!isKeyHash(meta.keyHash)) {
        throw new Error(
          `[smoke-scratchpad] ${span.input.name} span missing sha256 keyHash: ${JSON.stringify(meta)}`,
        );
      }
    }
    if (span.input.name === RUNTIME_SCRATCH_PROMOTE) {
      if (!isKeyHash(meta.fromKeyHash) || !isKeyHash(meta.toKeyHash)) {
        throw new Error(
          `[smoke-scratchpad] promote span missing sha256 from/to key hash: ${JSON.stringify(meta)}`,
        );
      }
    }
  }

  // Reads recorded hit/miss: the promote-source reads and round-trips are hits;
  // no genuine miss is expected in this happy-path run.
  const readEnds = byName(RUNTIME_SCRATCH_READ).map((s) => s.end?.metadata ?? {});
  if (!readEnds.some((m) => m.hit === true)) {
    throw new Error("[smoke-scratchpad] expected at least one read span with hit=true");
  }

  // The two terminal snapshots each persisted 6 rows with zero corruption.
  const snapshotEnds = byName(RUNTIME_SCRATCH_SNAPSHOT).map((s) => s.end?.metadata ?? {});
  for (const meta of snapshotEnds) {
    const persisted = Number(meta.persisted);
    const corrupt = Number(meta.corrupt);
    const sharedCount = Number(meta.sharedCount ?? 0);
    const scratchCount = Number(meta.scratchCount ?? 0);
    if (persisted !== 6 || corrupt !== 0) {
      throw new Error(
        `[smoke-scratchpad] snapshot span metadata off: ${JSON.stringify(meta)} (want persisted=6, corrupt=0)`,
      );
    }
    if (sharedCount + scratchCount !== persisted) {
      throw new Error(
        `[smoke-scratchpad] snapshot zone split does not sum to persisted: ${JSON.stringify(meta)}`,
      );
    }
  }

  assertNoRawLeak(capturedSpans);
  console.log(
    `[smoke-scratchpad] health spans ok (${capturedSpans.length} spans, no raw values/keys leaked)`,
  );

  // 6. Corrupt/miss contract. The happy path never exercises an unparseable
  //    entry or a genuine miss, yet those are exactly what the read `corrupt`
  //    flag and the snapshot `corrupt`/`scanned` counters exist to surface.
  //    Install a fresh capture, plant one unparseable key beside the 6 live
  //    ones, and assert the spans tell corruption apart from an absent key.
  const corruptSpans: CapturedScratchSpan[] = [];
  const restoreCorruptCapture = _setScratchRuntimeSpanStarterForTests((input) => {
    const record: CapturedScratchSpan = { input };
    corruptSpans.push(record);
    return {
      end(args) {
        record.end = args;
      },
    };
  });

  const seedConn = createRedisConnection();
  try {
    // Bypass writeScratch so the envelope is deliberately unparseable.
    await seedConn.set(`alfred:scratch:${runId}:shared.corrupt`, "{ not valid json", "EX", 300);
  } finally {
    await seedConn.quit().catch(() => seedConn.disconnect());
  }

  // Present-but-unparseable: hit=true (the key exists) yet corrupt=true, and
  // readScratch still honors its degrade-to-null contract.
  if ((await readScratch({ runId, zone: "shared", path: "corrupt" })) !== null) {
    throw new Error("[smoke-scratchpad] corrupt read should degrade to null");
  }
  // Genuinely absent: hit=false, corrupt=false.
  if ((await readScratch({ runId, zone: "shared", path: "absent" })) !== null) {
    throw new Error("[smoke-scratchpad] absent read should be null");
  }

  const corruptCount = await snapshotScratchToPostgres(runId);
  if (corruptCount !== 6) {
    throw new Error(
      `[smoke-scratchpad] corrupt key must be skipped, expected 6 persisted, got ${corruptCount}`,
    );
  }
  restoreCorruptCapture();

  const corruptReadEnds = corruptSpans
    .filter((s) => s.input.name === RUNTIME_SCRATCH_READ)
    .map((s) => s.end?.metadata ?? {});
  if (!corruptReadEnds.some((m) => m.hit === true && m.corrupt === true)) {
    throw new Error("[smoke-scratchpad] expected a read span with hit=true, corrupt=true");
  }
  if (!corruptReadEnds.some((m) => m.hit === false && m.corrupt === false)) {
    throw new Error("[smoke-scratchpad] expected a read span with hit=false (genuine miss)");
  }

  const corruptSnapshotEnd =
    corruptSpans.find((s) => s.input.name === RUNTIME_SCRATCH_SNAPSHOT)?.end?.metadata ?? {};
  const cScanned = Number(corruptSnapshotEnd.scanned);
  const cPersisted = Number(corruptSnapshotEnd.persisted);
  const cCorrupt = Number(corruptSnapshotEnd.corrupt);
  if (cPersisted !== 6 || cCorrupt !== 1) {
    throw new Error(
      `[smoke-scratchpad] corrupt snapshot span off: ${JSON.stringify(corruptSnapshotEnd)} (want persisted=6, corrupt=1)`,
    );
  }
  if (cScanned !== cPersisted + cCorrupt) {
    throw new Error(
      `[smoke-scratchpad] snapshot scanned should equal persisted+corrupt: ${JSON.stringify(corruptSnapshotEnd)}`,
    );
  }
  assertNoRawLeak(corruptSpans);
  console.log("[smoke-scratchpad] corrupt/miss health spans ok (corruption distinct from absent)");

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
  await db().delete(agentRunContext).where(eq(agentRunContext.runId, runId));
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
