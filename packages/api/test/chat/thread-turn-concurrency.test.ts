import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, describe, test } from "node:test";

import { closeConnections, db } from "@alfred/db";
import { CHAT_THREAD_ACTIVE_RUN_INDEX, agentRuns, chatThreads, user } from "@alfred/db/schemas";
import { databaseEnv } from "@alfred/env/database";
import { and, eq, inArray, sql } from "drizzle-orm";

import { closeRedis } from "../../src/queue/connection";
import { uniqueViolationConstraint } from "../../src/modules/agent/service";

/**
 * DB-backed guard for the per-thread turn concurrency invariant (#488).
 *
 * The turn kick used to dedupe only on `userMessageId`, so the ONLY thing
 * preventing two concurrent runs on one thread was the client's "not streaming"
 * submit gate. Once the composer can auto-fire queued/steered turns a completion
 * race could kick a second run before the first is terminal. The fix is a
 * partial unique index — {@link CHAT_THREAD_ACTIVE_RUN_INDEX} — enforcing at most
 * one non-terminal `__chat-turn__` run per (user, thread). This is the race-safe
 * boundary the kick relies on; the endpoint translates a 23505 on THIS index to
 * a typed "thread busy" response and a 23505 on the dedup index to double-submit
 * recovery, so these lock which constraint each collision trips.
 *
 * Opt-in: runs only when `DATABASE_URL` points at a reachable migrated Postgres.
 */
const SKIP = (() => {
  try {
    databaseEnv();
    return false;
  } catch {
    return "DATABASE_URL not set — skipping DB-backed test";
  }
})();

const CHAT_TURN_WORKFLOW_SLUG = "__chat-turn__";
const DEDUP_INDEX = "agent_runs_dedup_key_idx";
const ID_PREFIX = "test-turn-concurrency-";
const createdUserIds: string[] = [];

async function seedUserThread(): Promise<{ userId: string; threadId: string }> {
  const userId = `${ID_PREFIX}${randomUUID()}`;
  createdUserIds.push(userId);
  await db()
    .insert(user)
    .values({ id: userId, name: "Test User", email: `${userId}@example.test` });
  const threadId = randomUUID();
  await db().insert(chatThreads).values({ id: threadId, userId });
  return { userId, threadId };
}

/** Insert a chat-turn run row shaped exactly as `createRun` writes it. */
async function insertChatTurnRun(args: {
  userId: string;
  threadId: string;
  userMessageId: string;
  status?: string;
}): Promise<string> {
  const runId = `run_${randomUUID().slice(0, 12)}`;
  await db()
    .insert(agentRuns)
    .values({
      id: runId,
      userId: args.userId,
      workflowSlug: CHAT_TURN_WORKFLOW_SLUG,
      currentStep: "chat",
      status: args.status ?? "pending",
      dedupKey: `chat:${args.userMessageId}`,
      metadata: { threadId: args.threadId, userMessageId: args.userMessageId },
    });
  return runId;
}

async function expectUniqueViolation(fn: () => Promise<unknown>): Promise<string | null> {
  try {
    await fn();
  } catch (err) {
    return uniqueViolationConstraint(err);
  }
  throw new Error("expected a unique violation, but the insert succeeded");
}

const TERMINAL = new Set(["completed", "failed", "cancelled"]);

/** Count of NON-terminal chat-turn runs on the thread — the guarded quantity. */
async function countActiveThreadRuns(userId: string, threadId: string): Promise<number> {
  const rows = await db()
    .select({ id: agentRuns.id, status: agentRuns.status, metadata: agentRuns.metadata })
    .from(agentRuns)
    .where(and(eq(agentRuns.userId, userId), eq(agentRuns.workflowSlug, CHAT_TURN_WORKFLOW_SLUG)));
  return rows.filter((r) => {
    const meta = r.metadata as { threadId?: unknown } | null;
    return meta?.threadId === threadId && !TERMINAL.has(r.status);
  }).length;
}

describe("per-thread turn concurrency guard (#488)", { skip: SKIP }, () => {
  after(async () => {
    if (createdUserIds.length > 0) {
      await db().delete(user).where(inArray(user.id, createdUserIds));
    }
    await closeConnections();
    await closeRedis();
  });

  test("local schema has the per-thread active-run unique index", async () => {
    const result = await db().execute(sql`
      select count(*)::int as count
      from pg_indexes
      where tablename = 'agent_runs'
        and indexname = ${CHAT_THREAD_ACTIVE_RUN_INDEX}
    `);
    const row = Array.isArray(result) ? result[0] : result.rows[0];
    assert.equal(Number((row as { count: number }).count), 1);
  });

  test("a second overlapping kick on one thread is rejected → exactly one run", async () => {
    const { userId, threadId } = await seedUserThread();
    await insertChatTurnRun({ userId, threadId, userMessageId: `m-${randomUUID()}` });

    // A genuinely new turn (different user message) while the first is in flight.
    const constraint = await expectUniqueViolation(() =>
      insertChatTurnRun({ userId, threadId, userMessageId: `m-${randomUUID()}` }),
    );
    assert.equal(constraint, CHAT_THREAD_ACTIVE_RUN_INDEX);
    assert.equal(await countActiveThreadRuns(userId, threadId), 1);
  });

  test("a duplicate kick (same user message) trips the dedup index, not the thread index", async () => {
    const { userId, threadId } = await seedUserThread();
    const userMessageId = `m-${randomUUID()}`;
    await insertChatTurnRun({ userId, threadId, userMessageId });

    const constraint = await expectUniqueViolation(() =>
      insertChatTurnRun({ userId, threadId, userMessageId }),
    );
    // Same dedup key → the double-submit index wins the collision, so the
    // endpoint recovers the in-flight run instead of returning busy.
    assert.equal(constraint, DEDUP_INDEX);
  });

  test("a sequential kick after the prior run reaches a terminal state succeeds", async () => {
    const { userId, threadId } = await seedUserThread();
    let activeRunId = await insertChatTurnRun({
      userId,
      threadId,
      userMessageId: `m-${randomUUID()}`,
    });

    // Each terminal status frees the thread: the prior run leaves the
    // active-index predicate, so a fresh turn is admitted (no busy collision).
    for (const terminal of ["completed", "failed", "cancelled"] as const) {
      await db().update(agentRuns).set({ status: terminal }).where(eq(agentRuns.id, activeRunId));
      activeRunId = await insertChatTurnRun({
        userId,
        threadId,
        userMessageId: `m-${randomUUID()}`,
      });
      assert.equal(await countActiveThreadRuns(userId, threadId), 1);
    }
  });
});
