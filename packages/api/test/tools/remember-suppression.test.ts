import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, before, describe, test } from "node:test";

import type { TodoSource } from "@alfred/contracts";
import { closeConnections, db } from "@alfred/db";
import { documents, todos, user } from "@alfred/db/schemas";
import { databaseEnv } from "@alfred/env/database";
import { eq, inArray, like } from "drizzle-orm";

import { closeReplicachePokeBridge } from "../../src/events/replicache-events";
import { rememberSenderSuppression } from "@alfred/assistant/knowledge";
import { closeRedis } from "@alfred/db/redis";
import { rememberSenderSuppressionAndDismissTodos } from "../../src/modules/tools/remember-suppression";

function hasDatabaseUrl(): boolean {
  try {
    return Boolean(databaseEnv().DATABASE_URL);
  } catch {
    return false;
  }
}

const SKIP = hasDatabaseUrl() ? false : "DATABASE_URL not set — skipping DB-backed test";
const ID_PREFIX = "test-remember-suppression-";
const SENDER = "billing@example.com";
const createdUserIds: string[] = [];

async function seedUser(): Promise<string> {
  const userId = `${ID_PREFIX}${randomUUID()}`;
  createdUserIds.push(userId);
  await db()
    .insert(user)
    .values({ id: userId, name: "Remember Suppression Test", email: `${userId}@example.test` });
  return userId;
}

/** A live gmail-sourced todo whose thread's sender matches {@link SENDER}. */
async function seedGmailTodoFromSender(userId: string): Promise<{ todoId: string }> {
  const threadId = `thread_${randomUUID().slice(0, 12)}`;
  await db()
    .insert(documents)
    .values({
      id: `doc_${randomUUID().slice(0, 12)}`,
      userId,
      source: "gmail",
      sourceId: `msg_${randomUUID()}`,
      sourceThreadId: threadId,
      title: "Invoice due",
      content: "fixture body",
      contentHash: `hash_${randomUUID()}`,
      authoredAt: new Date(),
      ingestedAt: new Date(),
      metadata: { from: `Billing <${SENDER}>`, snippet: "Invoice due" },
    });
  const todoId = `todo_${randomUUID().slice(0, 12)}`;
  const sources = [{ provider: "gmail", kind: "thread", id: threadId }] satisfies TodoSource[];
  await db()
    .insert(todos)
    .values({ id: todoId, userId, name: "Pay the invoice", status: "open", sources });
  return { todoId };
}

async function todoStatus(todoId: string): Promise<string | undefined> {
  const [row] = await db()
    .select({ status: todos.status })
    .from(todos)
    .where(eq(todos.id, todoId))
    .limit(1);
  return row?.status;
}

describe("rememberSenderSuppression coordinator (DB-backed)", { skip: SKIP }, () => {
  before(async () => {
    await db()
      .delete(user)
      .where(like(user.id, `${ID_PREFIX}%`));
  });

  after(async () => {
    if (createdUserIds.length > 0) {
      await db().delete(user).where(inArray(user.id, createdUserIds));
    }
    await closeReplicachePokeBridge();
    await closeRedis();
    await closeConnections();
  });

  test("the pure knowledge write leaves the sender's open todos untouched", async () => {
    const userId = await seedUser();
    const { todoId } = await seedGmailTodoFromSender(userId);

    const result = await rememberSenderSuppression({ userId, senderEmail: SENDER });
    assert.equal(result.ok, true);

    // memory no longer reaches into tasks: the matching todo is still open.
    assert.equal(await todoStatus(todoId), "open");
  });

  test("the coordinator dismisses the sender's todos on the `remembered` path", async () => {
    const userId = await seedUser();
    const { todoId } = await seedGmailTodoFromSender(userId);

    const result = await rememberSenderSuppressionAndDismissTodos({ userId, senderEmail: SENDER });
    assert.equal(result.ok, true);
    if (!result.ok) throw new Error("unreachable");
    assert.equal(result.status, "remembered");
    assert.equal(result.resolvedTodos.ok, true);
    if (!result.resolvedTodos.ok) throw new Error("unreachable");
    assert.equal(result.resolvedTodos.status, "dismissed");
    assert.equal(result.resolvedTodos.dismissedCount, 1);
    assert.equal(await todoStatus(todoId), "dismissed");
  });

  test("the coordinator still dismisses on the `already_exists` path", async () => {
    const userId = await seedUser();
    const first = await seedGmailTodoFromSender(userId);

    // First call mints the suppression (remembered) and dismisses the first todo.
    const remembered = await rememberSenderSuppressionAndDismissTodos({
      userId,
      senderEmail: SENDER,
    });
    assert.equal(remembered.ok, true);
    if (!remembered.ok) throw new Error("unreachable");
    assert.equal(remembered.status, "remembered");
    assert.equal(await todoStatus(first.todoId), "dismissed");

    // A new open todo from the same sender arrives after the suppression exists.
    const second = await seedGmailTodoFromSender(userId);

    // Second call hits the `already_exists` branch and must still dismiss.
    const again = await rememberSenderSuppressionAndDismissTodos({ userId, senderEmail: SENDER });
    assert.equal(again.ok, true);
    if (!again.ok) throw new Error("unreachable");
    assert.equal(again.status, "already_exists");
    assert.equal(again.resolvedTodos.status, "dismissed");
    assert.equal(await todoStatus(second.todoId), "dismissed");
  });
});
