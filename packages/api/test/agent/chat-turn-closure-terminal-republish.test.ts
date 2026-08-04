import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, before, describe, test } from "node:test";

import { closeConnections, db } from "@alfred/db";
import { agentRuns, chatMessages, chatThreads, eventsOutbox, user } from "@alfred/db/schemas";
import { and, eq, inArray, like } from "drizzle-orm";

import { closeRedis } from "../../src/queue/connection";
import {
  finalizeAssistantMessage,
  finalizeFailedMessage,
} from "../../src/modules/agent/workflows/chat-turn-closure";
import {
  chatRunStateSchema,
  type ChatRunState,
} from "../../src/modules/agent/workflows/chat-turn-state";
import { CHAT_TURN_WORKFLOW_SLUG } from "../../src/modules/agent/workflows/chat-turn";
import { resetToolFixtures } from "../lib/tool-fixtures";

/**
 * DB-backed test for the replay-barrier release hole (campaign item 38, path 1).
 *
 * The client arms a replay-recovery barrier on `chat.message started` and
 * releases it only on `chat.message completed`. `closeChatTurn` writes the
 * assistant row and then, several statements later, publishes that frame. A
 * first attempt that writes a terminal (`complete`) row but throws before the
 * publish — e.g. `finalizeRunArtifacts` faults — leaves the row and NO frame. On
 * retry the guarded upsert (`onlyIfPreviousAttemptFailed`) matches nothing and
 * returns zero rows, so the old unconditional early return published the frame
 * NEVER, and the barrier leaked forever.
 *
 * These pin the fix: on ANY terminal retry over an already-terminal row — the
 * zero-row branch — the closure republishes the frame and nothing else. The
 * release is ending-independent, so a `failed` retry republishes it too. That
 * `failed` case is the reachable one: a `completed` close that faults after
 * writing its `complete` row is caught in `chatTurnStep` and re-routed through
 * `finalizeFailedMessage`, so the retry that finds the terminal row arrives as a
 * `failed` close. Gating the republish on the ending would relocate the barrier
 * leak to that branch — the exact regression round 2 caught.
 *
 * The seed reproduces the state that caught-throw leaves — a `complete` row for
 * `(messageId, runId)` with no `chat.message` frame in the outbox — rather than
 * stubbing the throw, because there is no injection seam for
 * `finalizeRunArtifacts`. Calling `finalizeFailedMessage` over that row IS what
 * `chatTurnStep`'s `catch` (and the executor's `onTerminal("failed")`) do, so the
 * closure sees the identical committed state the real retry sees.
 *
 * Opt-in: runs only when `DATABASE_URL` points at a reachable migrated Postgres.
 */
const SKIP = process.env.DATABASE_URL ? false : "DATABASE_URL not set — skipping DB-backed test";

const ID_PREFIX = "test-closure-republish-";
const createdUserIds: string[] = [];

async function seedThread(): Promise<{ userId: string; threadId: string; rowVersion: number }> {
  const userId = `${ID_PREFIX}${randomUUID()}`;
  createdUserIds.push(userId);
  await db()
    .insert(user)
    .values({ id: userId, name: "Test", email: `${userId}@example.test` });
  const rows = await db()
    .insert(chatThreads)
    .values({ userId, title: "Placeholder title" })
    .returning({ id: chatThreads.id, rowVersion: chatThreads.rowVersion });
  const thread = rows[0];
  assert.ok(thread, "seeded a chat thread");
  return { userId, threadId: thread.id, rowVersion: thread.rowVersion };
}

/**
 * A chat run whose first closure attempt has already landed a terminal row: the
 * run is `running` (not cancelled, so closure does not yield), the assistant row
 * is `complete`, and the outbox holds no `chat.message` frame.
 */
async function seedTerminalRowAttempt(status: "complete" | "failed"): Promise<{
  userId: string;
  threadId: string;
  runId: string;
  messageId: string;
  threadRowVersion: number;
  state: ChatRunState;
}> {
  const { userId, threadId, rowVersion } = await seedThread();
  const runId = `run_${randomUUID().slice(0, 12)}`;
  const messageId = `msg_${randomUUID().slice(0, 12)}`;
  await db().insert(agentRuns).values({
    id: runId,
    userId,
    workflowSlug: CHAT_TURN_WORKFLOW_SLUG,
    currentStep: "chat-turn",
    status: "running",
    attempt: 1,
    lastCheckpointAt: new Date(),
    state: { threadId, messageId },
  });
  await db()
    .insert(chatMessages)
    .values({
      id: messageId,
      userId,
      threadId,
      role: "assistant",
      content: "The committed reply.",
      status,
      errorKind: status === "failed" ? "generic" : null,
      runId,
    });
  const state = chatRunStateSchema.parse({
    threadId,
    messageId,
    tier: "standard",
    allowedIntegrations: [],
    pendingToolCalls: [],
    activeTools: [],
    assistantText: "The committed reply.",
    narration: [],
  });
  return { userId, threadId, runId, messageId, threadRowVersion: rowVersion, state };
}

async function readChatMessageEvents(userId: string): Promise<unknown[]> {
  const rows = await db()
    .select({ payload: eventsOutbox.payload })
    .from(eventsOutbox)
    .where(and(eq(eventsOutbox.userId, userId), eq(eventsOutbox.kind, "chat.message")))
    .orderBy(eventsOutbox.id);
  return rows.map((r) => r.payload);
}

async function readThreadRowVersion(threadId: string): Promise<number | undefined> {
  const rows = await db()
    .select({ rowVersion: chatThreads.rowVersion })
    .from(chatThreads)
    .where(eq(chatThreads.id, threadId));
  return rows[0]?.rowVersion;
}

describe(
  "chat-turn closure terminal republish (campaign 38, path 1, DB-backed)",
  { skip: SKIP },
  () => {
    before(async () => {
      // `chatRunStateSchema`'s transform restores the tool surface, which reads the
      // tool-runtime adapter; register the fixture adapter so the parse resolves.
      resetToolFixtures();
      await db()
        .delete(user)
        .where(like(user.id, `${ID_PREFIX}%`));
    });
    after(async () => {
      if (createdUserIds.length > 0) {
        await db().delete(user).where(inArray(user.id, createdUserIds));
      }
      resetToolFixtures();
      await closeConnections();
      await closeRedis();
    });

    test("a completed retry over an already-terminal row republishes the completed frame", async () => {
      const { userId, threadId, runId, messageId, threadRowVersion, state } =
        await seedTerminalRowAttempt("complete");

      await finalizeAssistantMessage(userId, runId, state);

      assert.deepEqual(
        await readChatMessageEvents(userId),
        [{ runId, threadId, messageId, phase: "completed" }],
        "the retry republishes the one frame that releases the client's replay barrier",
      );
      assert.equal(
        await readThreadRowVersion(threadId),
        threadRowVersion,
        "and touches nothing else: the thread row is not bumped a second time",
      );
    });

    test("a failed retry over an already-completed row STILL republishes the release frame", async () => {
      // The reachable barrier-leak path: attempt 1 completes, writes the
      // `complete` row, then faults before the frame; `chatTurnStep`'s catch
      // re-enters as `finalizeFailedMessage`, which finds the terminal row.
      const { userId, threadId, runId, messageId, threadRowVersion, state } =
        await seedTerminalRowAttempt("complete");

      await finalizeFailedMessage(userId, runId, state, new Error("late fault"));

      assert.deepEqual(
        await readChatMessageEvents(userId),
        [{ runId, threadId, messageId, phase: "completed" }],
        "the failed retry releases the barrier the faulted completed attempt armed",
      );
      const rows = await db()
        .select({ status: chatMessages.status })
        .from(chatMessages)
        .where(eq(chatMessages.id, messageId));
      assert.equal(rows[0]?.status, "complete", "and never demotes the completed row to failed");
      assert.equal(
        await readThreadRowVersion(threadId),
        threadRowVersion,
        "and touches nothing else: the thread row is not bumped a second time",
      );
    });

    test("a failed retry over an already-failed row republishes the frame and stays failed", async () => {
      // The other zero-row failed shape: attempt 1 already failed and wrote its
      // `failed` row (and sent the frame); a re-attempt is harmlessly redundant.
      const { userId, threadId, runId, messageId, state } = await seedTerminalRowAttempt("failed");

      await finalizeFailedMessage(userId, runId, state, new Error("second fault"));

      assert.deepEqual(
        await readChatMessageEvents(userId),
        [{ runId, threadId, messageId, phase: "completed" }],
        "a terminal chat.message is absorbing, so republishing it is idempotent",
      );
      const rows = await db()
        .select({ status: chatMessages.status })
        .from(chatMessages)
        .where(eq(chatMessages.id, messageId));
      assert.equal(rows[0]?.status, "failed", "and never promotes the failed row to complete");
    });
  },
);
