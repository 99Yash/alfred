import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, before, describe, test } from "node:test";

import { closeConnections, db } from "@alfred/db";
import {
  agentRuns,
  artifacts,
  chatMessages,
  chatThreads,
  user,
  type ArtifactStatus,
} from "@alfred/db/schemas";
import { eq, inArray, like } from "drizzle-orm";

import { closeRedis } from "@alfred/db/redis";
import {
  finalizeAssistantMessage,
  finalizeFailedMessage,
} from "../../src/modules/conversations/chat-turn-closure";
import {
  chatRunStateSchema,
  type ChatRunState,
} from "../../src/modules/conversations/chat-turn-state";
import { CHAT_TURN_WORKFLOW_SLUG } from "../../src/modules/conversations/chat-turn";
import { resetToolFixtures } from "../lib/tool-fixtures";

/**
 * DB-backed test for the late-fault artifact strand (campaign item 52).
 *
 * A chat turn authors artifacts that sit `generating` until the closure flips
 * them terminal via `finalizeRunArtifacts`. If attempt 1 faults INSIDE
 * `finalizeRunArtifacts` — after the `complete` row commits but before the
 * artifacts finish — the fault is caught in `chatTurnStep` and re-routed through
 * `finalizeFailedMessage`. The retry finds the already-terminal row, so the
 * guarded upsert / `onConflictDoNothing` returns zero rows and closure takes the
 * zero-row branch. Before this fix that branch republished the release frame but
 * did NOT re-run `finalizeRunArtifacts`, so the artifacts stayed `generating`
 * forever with no reaper to finish them.
 *
 * These pin the fix: the zero-row branch re-runs `finalizeRunArtifacts`
 * idempotently, deriving each artifact's terminal status from the PERSISTED
 * `chat_messages` row — NOT the retry's `outcome.kind`. A `completed` close that
 * faults re-enters as a `failed` close, so gating on the retry's kind would flip
 * a completed turn's artifacts to `error`; the persisted status is what keeps the
 * artifact terminal state matching the message.
 *
 * The seed reproduces the state the caught-throw leaves — a terminal row for
 * `(messageId, runId)` and a still-`generating` artifact — rather than stubbing
 * the throw, because there is no injection seam for `finalizeRunArtifacts`.
 * Calling `finalizeFailedMessage` over that state IS what `chatTurnStep`'s
 * `catch` (and the executor's `onTerminal("failed")`) do.
 *
 * Opt-in: runs only when `DATABASE_URL` points at a reachable migrated Postgres.
 */
const SKIP = process.env.DATABASE_URL ? false : "DATABASE_URL not set — skipping DB-backed test";

const ID_PREFIX = "test-closure-artifact-";
const createdUserIds: string[] = [];

async function seedThread(): Promise<{ userId: string; threadId: string }> {
  const userId = `${ID_PREFIX}${randomUUID()}`;
  createdUserIds.push(userId);
  await db()
    .insert(user)
    .values({ id: userId, name: "Test", email: `${userId}@example.test` });
  const rows = await db()
    .insert(chatThreads)
    .values({ userId, title: "Placeholder title" })
    .returning({ id: chatThreads.id });
  const thread = rows[0];
  assert.ok(thread, "seeded a chat thread");
  return { userId, threadId: thread.id };
}

/**
 * A chat run whose first closure attempt landed a terminal row AND authored one
 * artifact left in the given status: the run is `running` (not cancelled), the
 * assistant row is terminal, and the artifact was never closed out.
 */
async function seedTerminalRowWithArtifact(
  messageStatus: "complete" | "failed",
  artifactStatus: ArtifactStatus,
): Promise<{
  userId: string;
  threadId: string;
  runId: string;
  messageId: string;
  artifactId: string;
  state: ChatRunState;
}> {
  const { userId, threadId } = await seedThread();
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
      status: messageStatus,
      errorKind: messageStatus === "failed" ? "generic" : null,
      runId,
    });
  const artifactRows = await db()
    .insert(artifacts)
    .values({
      userId,
      threadId,
      runId,
      messageId,
      kind: "document",
      title: "Draft",
      status: artifactStatus,
    })
    .returning({ id: artifacts.id });
  const artifact = artifactRows[0];
  assert.ok(artifact, "seeded an artifact");
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
  return { userId, threadId, runId, messageId, artifactId: artifact.id, state };
}

async function readArtifactStatus(artifactId: string): Promise<string | undefined> {
  const rows = await db()
    .select({ status: artifacts.status })
    .from(artifacts)
    .where(eq(artifacts.id, artifactId));
  return rows[0]?.status;
}

describe("chat-turn closure artifact strand (campaign 52, DB-backed)", { skip: SKIP }, () => {
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

  test("a failed retry over a completed row flips the stranded artifact to complete", async () => {
    // The item's case: attempt 1 completes, writes the `complete` row, then
    // faults inside `finalizeRunArtifacts`; `chatTurnStep`'s catch re-enters as
    // `finalizeFailedMessage`, which finds the terminal row and zero-row branch.
    const { userId, runId, messageId, artifactId, state } = await seedTerminalRowWithArtifact(
      "complete",
      "generating",
    );

    await finalizeFailedMessage(userId, runId, state, new Error("late fault"));

    assert.equal(
      await readArtifactStatus(artifactId),
      "complete",
      "the artifact reaches the terminal status of the PERSISTED completed row, not the retry's failed kind",
    );
    const rows = await db()
      .select({ status: chatMessages.status })
      .from(chatMessages)
      .where(eq(chatMessages.id, messageId));
    assert.equal(rows[0]?.status, "complete", "and the message row stays complete");
  });

  test("a failed retry over a failed row flips the stranded artifact to error", async () => {
    // Genuine double-failure: attempt 1 failed and wrote its `failed` row; the
    // retry closes the still-`generating` artifact into `error`.
    const { userId, runId, artifactId, state } = await seedTerminalRowWithArtifact(
      "failed",
      "generating",
    );

    await finalizeFailedMessage(userId, runId, state, new Error("second fault"));

    assert.equal(
      await readArtifactStatus(artifactId),
      "error",
      "the artifact matches the persisted failed row",
    );
  });

  test("a retry over an already-complete artifact leaves it complete and does not throw", async () => {
    // Idempotency: attempt 1's `finalizeRunArtifacts` UPDATE committed before the
    // fault (e.g. the poke threw), so the artifact is already `complete`. Re-running
    // it is a no-op filtered on `status IN (generating)`.
    const { userId, runId, artifactId, state } = await seedTerminalRowWithArtifact(
      "complete",
      "complete",
    );

    await finalizeFailedMessage(userId, runId, state, new Error("late fault"));

    assert.equal(
      await readArtifactStatus(artifactId),
      "complete",
      "an already-terminal artifact is untouched",
    );
  });

  test("a completed retry over a completed row also flips a stranded artifact", async () => {
    // The other zero-row shape: a completed re-attempt that finds the terminal
    // row (guarded upsert matches nothing) still closes the artifact.
    const { userId, runId, artifactId, state } = await seedTerminalRowWithArtifact(
      "complete",
      "generating",
    );

    await finalizeAssistantMessage(userId, runId, state);

    assert.equal(
      await readArtifactStatus(artifactId),
      "complete",
      "the completed zero-row retry closes the artifact too",
    );
  });
});
