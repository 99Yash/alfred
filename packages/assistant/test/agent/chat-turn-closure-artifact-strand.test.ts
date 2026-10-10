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
import { registerReplicachePokeAdapter } from "@alfred/assistant/realtime";
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
 * A close can fault inside `finalizeRunArtifacts` after its row commits. The
 * retry must still close `generating` artifacts, or nothing ever will. The status
 * comes from the persisted row: a faulted `completed` close retries as `failed`.
 * The seed writes the state directly: `finalizeRunArtifacts` has no injection seam.
 */
const SKIP = dbBackedSkip("database");

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

/** A first close that wrote a terminal row and left one artifact in `artifactStatus`. */
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
  /** The seeded run's live lease, as `chatTurnStep` holds it. */
  lease: StepLease;
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

  return {
    userId,
    threadId,
    runId,
    messageId,
    artifactId: artifact.id,
    state,
    lease: { runId, attempt: 1, fence: { generation: 0 } },
  };
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

  test("a failed retry over a completed row flips the stranded artifact to complete", async () => {
    // `chatTurnStep`'s catch re-enters a faulted completed close as `finalizeFailedMessage`.
    const { userId, runId, messageId, artifactId, state, lease } =
      await seedTerminalRowWithArtifact("complete", "generating");

    await finalizeFailedMessage(userId, runId, state, new Error("late fault"), lease);

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
    const { userId, runId, artifactId, state, lease } = await seedTerminalRowWithArtifact(
      "failed",
      "generating",
    );

    await finalizeFailedMessage(userId, runId, state, new Error("second fault"), lease);

    assert.equal(
      await readArtifactStatus(artifactId),
      "error",
      "the artifact matches the persisted failed row",
    );
  });

  test("a retry over an already-complete artifact leaves it complete and does not throw", async () => {
    // The first close's artifact update committed before the fault.
    const { userId, runId, artifactId, state, lease } = await seedTerminalRowWithArtifact(
      "complete",
      "complete",
    );

    await finalizeFailedMessage(userId, runId, state, new Error("late fault"), lease);

    assert.equal(
      await readArtifactStatus(artifactId),
      "complete",
      "an already-terminal artifact is untouched",
    );
  });

  test("a completed retry over a completed row also flips a stranded artifact", async () => {
    const { userId, artifactId, state, lease } = await seedTerminalRowWithArtifact(
      "complete",
      "generating",
    );

    await finalizeAssistantMessage(userId, state, lease);

    assert.equal(
      await readArtifactStatus(artifactId),
      "complete",
      "the completed zero-row retry closes the artifact too",
    );
  });
});
