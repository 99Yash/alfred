import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, before, describe, test } from "node:test";

import { closeConnections, db } from "@alfred/db";
import { agentRuns, chatMessages, chatThreads, eventsOutbox, user } from "@alfred/db/schemas";
import { and, eq, inArray, like } from "drizzle-orm";

import { closeRedis } from "@alfred/db/redis";
import { registerReplicachePokeAdapter, subscribeUserPokes } from "@alfred/assistant/realtime";
import {
  finalizeAssistantMessage,
  finalizeFailedMessage,
} from "@alfred/assistant/chat/chat-turn-closure";
import { chatRunStateSchema, type ChatRunState } from "@alfred/assistant/chat/chat-turn-state";
import { CHAT_TURN_WORKFLOW_SLUG } from "@alfred/assistant/chat/chat-turn";
import type { StepLease } from "@alfred/assistant/execution";
import { resetToolFixtures } from "@alfred/assistant/tool-runtime/test-support";
import { dbBackedSkip } from "../support/db-backed";

/**
 * Only `chat.message completed` releases the client's replay barrier. A close can
 * write its terminal row and throw before the publish. Any retry over a terminal
 * row must republish that frame, whatever its ending.
 * The seed writes the row directly: `finalizeRunArtifacts` has no injection seam.
 */
const SKIP = dbBackedSkip("database");

/** With `REDIS_URL` set, pokes go to Redis and `subscribeUserPokes` sees none. */
const POKE_SKIP =
  dbBackedSkip("database") ||
  // drift-ok: needs REDIS_URL absent, which a presence-only guard cannot express.
  (process.env.REDIS_URL
    ? "REDIS_URL set — local poke assertions require the in-process bridge"
    : false);

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

/** A first close that wrote a terminal row but no frame. The run is not cancelled. */
async function seedTerminalRowAttempt(status: "complete" | "failed"): Promise<{
  userId: string;
  threadId: string;
  runId: string;
  messageId: string;
  threadRowVersion: number;
  state: ChatRunState;
  /** The seeded run's live lease, as `chatTurnStep` holds it. */
  lease: StepLease;
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

  return {
    userId,
    threadId,
    runId,
    messageId,
    threadRowVersion: rowVersion,
    state,
    lease: { runId, attempt: 1, fence: { generation: 0 } },
  };
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
      // `chatRunStateSchema`'s transform reads the tool-runtime adapter.
      resetToolFixtures();
      registerReplicachePokeAdapter();
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
      const { userId, threadId, runId, messageId, threadRowVersion, state, lease } =
        await seedTerminalRowAttempt("complete");

      await finalizeAssistantMessage(userId, state, lease);

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
      // The reachable path: `chatTurnStep`'s catch re-enters as `finalizeFailedMessage`.
      const { userId, threadId, runId, messageId, threadRowVersion, state, lease } =
        await seedTerminalRowAttempt("complete");

      await finalizeFailedMessage(userId, runId, state, new Error("late fault"), lease);

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
      const { userId, threadId, runId, messageId, state, lease } =
        await seedTerminalRowAttempt("failed");

      await finalizeFailedMessage(userId, runId, state, new Error("second fault"), lease);

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

    // The poke lives in `publishCompletedFrame`, so the republish must poke too.
    test(
      "the failed retry over a completed row also pokes Replicache",
      { skip: POKE_SKIP },
      async () => {
        const { userId, runId, state, lease } = await seedTerminalRowAttempt("complete");
        const pokes: string[] = [];
        const unsubscribe = subscribeUserPokes(userId, (poke) => pokes.push(poke.assetId));

        await finalizeFailedMessage(userId, runId, state, new Error("late fault"), lease);

        unsubscribe();
        assert.deepEqual(
          pokes,
          [""],
          "the republish path pokes exactly once for the user (empty asset id = user-scoped)",
        );
      },
    );

    test("a normal close pokes Replicache exactly once", { skip: POKE_SKIP }, async () => {
      // A prior `failed` row makes the upsert return a row, so the close writes in full.
      const { userId, state, lease } = await seedTerminalRowAttempt("failed");
      const pokes: string[] = [];
      const unsubscribe = subscribeUserPokes(userId, (poke) => pokes.push(poke.assetId));

      await finalizeAssistantMessage(userId, state, lease);

      unsubscribe();
      assert.deepEqual(pokes, [""], "the row-writing path pokes exactly once, not twice");
    });
  },
);
