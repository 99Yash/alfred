import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, before, describe, test } from "node:test";

import { closeConnections, db } from "@alfred/db";
import {
  agentRuns,
  artifacts,
  chatMessages,
  chatThreads,
  eventsOutbox,
  user,
} from "@alfred/db/schemas";
import { and, eq, inArray, like } from "drizzle-orm";

import { closeRedis } from "@alfred/db/redis";
import {
  _resetRegistryForTests,
  getWorkflow,
  registerRecipe,
} from "@alfred/assistant/execution/registry";
import { cancelRun } from "@alfred/assistant/execution/service";
import { CHAT_TURN_WORKFLOW_SLUG, chatTurnWorkflow } from "@alfred/assistant/chat/chat-turn";
import { resetToolFixtures } from "@alfred/assistant/tool-runtime/test-support";
import { dbBackedSkip } from "../support/db-backed";

/**
 * DB-backed closure tests for the ONE workflow that owes the user a visible
 * ending: chat-turn (#530/#531 review, finding D2).
 *
 * `commit-cancel-race.test.ts` proves the *runtime* obligation — a cancel drives
 * `onTerminal` with `outcome: "cancelled"` exactly once — through a recording
 * stand-in workflow. That left
 * the production implementation of the hook untested, which is where the
 * regression actually lived: under the terminal commit guard both commits roll
 * back, so if chat-turn's cancel branch doesn't persist the assistant row and
 * emit `chat.message completed`, the streaming bubble hangs forever. These drive
 * the real `chatTurnWorkflow` through the real `cancelRun`.
 *
 * What they pin, deliberately, is the *committed*-state semantics: closure
 * re-reads `agent_runs.state`, so a cancel renders the last step boundary — not
 * whatever the rolled-back in-flight step had accumulated. A cancel landing
 * inside the first assistant step therefore closes an empty turn, and that is
 * the honest behaviour, not a bug to paper over: the alternative would be
 * persisting text no commit ever accepted.
 *
 * Not asserted here: that a cancel skips the success tail (memory capture,
 * compaction, titling). That divergence is enforced by construction —
 * `finalizeCancelledMessage` calls the row-only finalizer and the schedulers are
 * unreachable from it — and every one of them is flag-and-Redis gated, so an
 * "it didn't fire" assertion would pass in this environment whether or not the
 * code called it. A test that can't fail isn't evidence.
 *
 * Opt-in: runs only when `DATABASE_URL` points at a reachable migrated Postgres.
 */
const SKIP = dbBackedSkip("database");

const ID_PREFIX = "test-chat-cancel-";
const createdUserIds: string[] = [];
const STEP = "chat-turn";
const CANCEL_REASON = "cancelled_by_user";

/**
 * A committed chat-turn checkpoint. Deliberately NOT typed as `ChatRunState`:
 * that is the parse *output*, and what a real checkpoint holds is partial input
 * JSON the schema fills in. Typing it as the output would let the seed skip the
 * validation every real cancel goes through — closure parses `agent_runs.state`,
 * and a seed the schema rejects must fail this test, not bypass it.
 */
function committedState(args: {
  threadId: string;
  messageId: string;
  assistantText: string;
  narration?: { index: number; text: string }[];
}): Record<string, unknown> {
  return {
    threadId: args.threadId,
    messageId: args.messageId,
    tier: "standard",
    allowedIntegrations: [],
    pendingToolCalls: [],
    // Explicitly empty rather than absent: an absent list means "legacy
    // checkpoint" and the schema back-fills today's kernel, which needs a live
    // tool registry this test has no reason to stand up.
    activeTools: [],
    assistantText: args.assistantText,
    narration: args.narration ?? [],
  };
}

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
  const threadId = rows[0]?.id;
  assert.ok(threadId, "seeded a chat thread");
  return { userId, threadId };
}

/**
 * A chat run parked exactly where the only production cancel caller finds one:
 * `waiting` on an approval, its state at the last committed step boundary.
 */
async function seedWaitingChatRun(args: {
  assistantText: string;
  narration?: { index: number; text: string }[];
}): Promise<{ userId: string; threadId: string; runId: string; messageId: string }> {
  const { userId, threadId } = await seedThread();
  const runId = `run_${randomUUID().slice(0, 12)}`;
  const messageId = `msg_${randomUUID().slice(0, 12)}`;
  await db()
    .insert(agentRuns)
    .values({
      id: runId,
      userId,
      workflowSlug: CHAT_TURN_WORKFLOW_SLUG,
      currentStep: STEP,
      status: "waiting",
      attempt: 1,
      lastCheckpointAt: new Date(),
      state: committedState({ threadId, messageId, ...args }),
    });
  return { userId, threadId, runId, messageId };
}

async function readAssistantMessage(messageId: string) {
  const rows = await db()
    .select({
      status: chatMessages.status,
      role: chatMessages.role,
      content: chatMessages.content,
      errorKind: chatMessages.errorKind,
      narration: chatMessages.narration,
      runId: chatMessages.runId,
    })
    .from(chatMessages)
    .where(eq(chatMessages.id, messageId));
  return rows[0];
}

/** The frames the client's streaming bubble ends on, oldest first. */
async function readChatMessageEvents(userId: string): Promise<unknown[]> {
  const rows = await db()
    .select({ payload: eventsOutbox.payload })
    .from(eventsOutbox)
    .where(and(eq(eventsOutbox.userId, userId), eq(eventsOutbox.kind, "chat.message")))
    .orderBy(eventsOutbox.id);
  return rows.map((r) => r.payload);
}

describe("chat-turn cancel closure (#530/#531 D2, DB-backed)", { skip: SKIP }, () => {
  before(async () => {
    resetToolFixtures();
    await db()
      .delete(user)
      .where(like(user.id, `${ID_PREFIX}%`));
    // The production workflow, not a stand-in: closure resolves the hook off the
    // run's `workflow_slug` through the registry, and the whole point here is
    // that chat-turn's own `onTerminal` cancel branch does the work.
    if (!getWorkflow(CHAT_TURN_WORKFLOW_SLUG)) registerRecipe(chatTurnWorkflow);
  });
  after(async () => {
    if (createdUserIds.length > 0) {
      await db().delete(user).where(inArray(user.id, createdUserIds));
    }
    _resetRegistryForTests();
    resetToolFixtures();
    await closeConnections();
    // The cancel's post-commit obligations touch Redis (scratch snapshot,
    // Replicache pokes), so the connection has to come down with the pool.
    await closeRedis();
  });

  test("a cancelled chat turn persists its assistant row and ends the bubble", async () => {
    const { userId, threadId, runId, messageId } = await seedWaitingChatRun({
      assistantText: "Here is the draft reply.",
      narration: [{ index: 0, text: "Checking your calendar." }],
    });

    assert.equal(await cancelRun({ runId, reason: CANCEL_REASON }), "cancelled");

    const message = await readAssistantMessage(messageId);
    assert.ok(message, "the cancel persisted the assistant row (nothing else will)");
    assert.equal(message.role, "assistant");
    assert.equal(
      message.status,
      "complete",
      "a deliberate stop is not an error: `failed` would render 'something went wrong, retry?' for an action the user took on purpose",
    );
    assert.equal(message.errorKind, null, "and carries no error kind to pattern-match on");
    assert.equal(message.content, "Here is the draft reply.", "carrying the committed text");
    assert.deepEqual(
      message.narration,
      [{ index: 0, text: "Checking your calendar." }],
      "and the committed narration segments, so the trail survives reload",
    );
    assert.equal(message.runId, runId);

    assert.deepEqual(
      await readChatMessageEvents(userId),
      [{ runId, threadId, messageId, phase: "completed" }],
      "`chat.message completed` is the only frame that stops the client streaming",
    );
  });

  test("the closed turn renders the last committed state, so a first-step cancel closes empty", async () => {
    // A mid-step cancel rolls the in-flight step's commit back, and closure
    // re-reads `agent_runs.state` — so the text the rolled-back step had
    // accumulated is gone by construction. Cancel inside the FIRST assistant
    // step and the committed boundary holds no text at all. Ending an empty
    // turn is still ending it; the bubble must not hang waiting for text no
    // commit ever accepted.
    const { userId, threadId, runId, messageId } = await seedWaitingChatRun({
      assistantText: "",
    });

    assert.equal(await cancelRun({ runId, reason: CANCEL_REASON }), "cancelled");

    const message = await readAssistantMessage(messageId);
    assert.ok(message, "the row still lands");
    assert.equal(message.content, "", "with no text, because none was ever committed");
    assert.equal(message.status, "complete");
    assert.deepEqual(await readChatMessageEvents(userId), [
      { runId, threadId, messageId, phase: "completed" },
    ]);
  });

  test("artifacts the cancelled turn was drafting close readable, not broken", async () => {
    const { userId, threadId, runId, messageId } = await seedWaitingChatRun({
      assistantText: "Drafting the deck.",
    });
    const artifactRows = await db()
      .insert(artifacts)
      .values({
        userId,
        threadId,
        runId,
        kind: "document",
        title: "Half-written doc",
        status: "generating",
        content: { kind: "document", markdown: "First section only." },
      })
      .returning({ id: artifacts.id });
    const artifactId = artifactRows[0]?.id;
    assert.ok(artifactId, "seeded a still-generating artifact");

    assert.equal(await cancelRun({ runId, reason: CANCEL_REASON }), "cancelled");

    const rows = await db()
      .select({ status: artifacts.status, messageId: artifacts.messageId })
      .from(artifacts)
      .where(eq(artifacts.id, artifactId));
    assert.equal(
      rows[0]?.status,
      "complete",
      "the sidebar leaves the placeholder state showing what was drafted, not an error",
    );
    assert.equal(rows[0]?.messageId, messageId, "and the artifact is tied to the closed turn");
  });

  test("cancel repairs a concurrently failed row and artifact", async () => {
    const { userId, threadId, runId, messageId } = await seedWaitingChatRun({
      assistantText: "The committed draft.",
    });
    await db().insert(chatMessages).values({
      id: messageId,
      userId,
      threadId,
      role: "assistant",
      content: "partial",
      status: "failed",
      errorKind: "generic",
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
        title: "Recovered doc",
        status: "error",
        content: { kind: "document", markdown: "Still useful." },
      })
      .returning({ id: artifacts.id });
    const artifactId = artifactRows[0]?.id;
    assert.ok(artifactId);

    assert.equal(await cancelRun({ runId, reason: CANCEL_REASON }), "cancelled");

    const message = await readAssistantMessage(messageId);
    assert.equal(message?.status, "complete");
    assert.equal(
      message?.errorKind,
      null,
      "failed → complete clears the stale retry classification",
    );
    const artifact = await db()
      .select({ status: artifacts.status })
      .from(artifacts)
      .where(eq(artifacts.id, artifactId));
    assert.equal(
      artifact[0]?.status,
      "complete",
      "cancel wins over the step body's error finalizer",
    );
  });

  test("a second cancel does not re-close the turn", async () => {
    const { userId, runId, messageId } = await seedWaitingChatRun({
      assistantText: "First and only.",
    });
    assert.equal(await cancelRun({ runId, reason: CANCEL_REASON }), "cancelled");

    assert.equal(
      await cancelRun({ runId, reason: "second" }),
      "already_terminal",
      "the cancel is a no-op on an already-terminal run",
    );

    assert.equal((await readChatMessageEvents(userId)).length, 1, "so the client sees one ending");
    const message = await readAssistantMessage(messageId);
    assert.equal(message?.content, "First and only.", "and the row is untouched");
  });
});
