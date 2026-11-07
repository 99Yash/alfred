import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, describe, test } from "node:test";

import type { TodoSource, TodoStatus } from "@alfred/contracts";
import { closeConnections, db } from "@alfred/db";
import { agentRuns, todos, user } from "@alfred/db/schemas";
import { inArray } from "drizzle-orm";

import { suggestTodo } from "../../src/tasks/suggest";
import { dbBackedSkip } from "../support/db-backed";

// SM-06 in docs/reference/state-machines.md: a todo the user handled must suppress a re-suggestion
// of the same identity for the window, whether they left it `done` or cleared it from the rail.

const SKIP = dbBackedSkip("database");

const ID_PREFIX = "test-suggest-resolved-window-";

const createdUserIds: string[] = [];

after(async () => {
  if (createdUserIds.length > 0) {
    await db().delete(user).where(inArray(user.id, createdUserIds));
  }

  await closeConnections();
});

async function seedUserAndRun(): Promise<{ userId: string; runId: string }> {
  const userId = `${ID_PREFIX}${randomUUID()}`;
  createdUserIds.push(userId);
  await db()
    .insert(user)
    .values({ id: userId, name: "Suggest Window", email: `${userId}@example.test` });

  const runId = `run-${randomUUID()}`;
  await db()
    .insert(agentRuns)
    .values({ id: runId, userId, workflowSlug: "email-triage", currentStep: "classify" });

  return { userId, runId };
}

function issueSource(): TodoSource {
  return { provider: "github", kind: "issue", id: `acme/app#${randomUUID()}` };
}

async function seedResolvedTodo(
  userId: string,
  status: TodoStatus,
  source: TodoSource,
): Promise<string> {
  const [row] = await db()
    .insert(todos)
    .values({
      userId,
      name: "Review the PR",
      status,
      createdBy: "user",
      sources: [source],
      attribution: {
        actor: "user",
        authority: "user_direct",
        authorityRef: null,
        cause: status === "done" ? "completed" : status,
      },
    })
    .returning({ id: todos.id });

  assert.ok(row);

  return row.id;
}

function suggest(userId: string, runId: string, source: TodoSource) {
  return suggestTodo({
    userId,
    attribution: {
      actor: "agent",
      runId,
      toolCallId: `${runId}:classify:1`,
      authority: null,
      authorityRef: null,
      cause: "suggested",
    },
    name: "Review the PR",
    sources: [source],
  });
}

describe("suggestTodo resolved-identity window (DB-backed)", { skip: SKIP }, () => {
  for (const status of ["done", "cleared", "dismissed"] as const) {
    test(`a recently ${status} todo suppresses the same identity`, async () => {
      const { userId, runId } = await seedUserAndRun();
      const source = issueSource();
      const resolvedId = await seedResolvedTodo(userId, status, source);

      const result = await suggest(userId, runId, source);

      assert.equal(result.status, "suppressed");
      assert.equal(result.todoId, resolvedId);
    });
  }
});
