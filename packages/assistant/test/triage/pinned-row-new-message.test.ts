/**
 * SM-09: a user retag pins only the thread's tag. A newer message on that thread must still
 * write its evaluation (`written: true`), so triage mints its todo and publishes the
 * classified event, and the reply-draft gate sees the row owned by the new message.
 */

import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, before, describe, test } from "node:test";

import type { TriageModelVerdict } from "@alfred/contracts";
import { closeConnections, db } from "@alfred/db";
import { documents, emailTriage, user } from "@alfred/db/schemas";
import { and, eq, inArray, like } from "drizzle-orm";

import { dbBackedSkip } from "../support/db-backed";
import { upsertTriage, type UpsertTriageArgs } from "../../src/triage/store";

const SKIP = dbBackedSkip("database");

const ID_PREFIX = "test-triage-pinned-row-";

const createdUserIds: string[] = [];

const PINNED_AT = new Date("2026-06-27T10:05:00.000Z");

const OLD_AUTHORED_AT = new Date("2026-06-27T10:00:00.000Z");

const NEW_AUTHORED_AT = new Date("2026-06-27T11:00:00.000Z");

const NEW_VERDICT: TriageModelVerdict = {
  category: "action_needed",
  documentAsk: null,
  todoSuggestion: { name: "Send the signed contract" },
  todoDecision: null,
  exposedSecret: false,
};

async function seedGmailDocument(
  userId: string,
  sourceThreadId: string,
  authoredAt: Date,
): Promise<string> {
  const id = `doc_${randomUUID().slice(0, 12)}`;
  await db()
    .insert(documents)
    .values({
      id,
      userId,
      source: "gmail",
      sourceId: `msg_${randomUUID()}`,
      sourceThreadId,
      title: "Pinned thread message",
      content: "fixture",
      contentHash: `hash_${randomUUID()}`,
      authoredAt,
      metadata: {},
    });

  return id;
}

/** A thread the user retagged `fyi` on its first message, with the Gmail label applied. */
async function seedPinnedThread(): Promise<{
  userId: string;
  sourceThreadId: string;
  pinnedDocId: string;
}> {
  const userId = `${ID_PREFIX}${randomUUID()}`;
  createdUserIds.push(userId);
  await db()
    .insert(user)
    .values({ id: userId, name: "Pinned Test User", email: `${userId}@example.test` });

  const sourceThreadId = `thread_${randomUUID()}`;
  const pinnedDocId = await seedGmailDocument(userId, sourceThreadId, OLD_AUTHORED_AT);

  await db().insert(emailTriage).values({
    userId,
    sourceThreadId,
    documentId: pinnedDocId,
    category: "fyi",
    confidence: 0.9,
    rationale: "first message",
    model: "test-model",
    modelVerdict: null,
    instructionEvaluation: null,
    runId: null,
    source: "user",
    overriddenAt: PINNED_AT,
    appliedLabelId: "Label_fyi",
    classifiedAt: OLD_AUTHORED_AT,
  });

  return { userId, sourceThreadId, pinnedDocId };
}

function classifyArgs(
  userId: string,
  sourceThreadId: string,
  documentId: string,
  authoredAt: Date,
): UpsertTriageArgs {
  return {
    userId,
    sourceThreadId,
    documentId,
    category: "action_needed",
    confidence: 0.8,
    rationale: "the new message asks for the contract",
    model: "test-model",
    runId: null,
    todoSuggestion: NEW_VERDICT.todoSuggestion,
    modelVerdict: NEW_VERDICT,
    instructionEvaluation: null,
    authoredAt,
  };
}

async function storedRow(userId: string, sourceThreadId: string) {
  const [row] = await db()
    .select()
    .from(emailTriage)
    .where(and(eq(emailTriage.userId, userId), eq(emailTriage.sourceThreadId, sourceThreadId)));

  return row;
}

describe("upsertTriage on a user-pinned thread (DB-backed)", { skip: SKIP }, () => {
  before(async () => {
    await db()
      .delete(user)
      .where(like(user.id, `${ID_PREFIX}%`));
  });

  after(async () => {
    if (createdUserIds.length > 0) {
      await db().delete(user).where(inArray(user.id, createdUserIds));
    }

    await closeConnections();
  });

  test("a newer message writes its evaluation and keeps the user's tag", async () => {
    const { userId, sourceThreadId } = await seedPinnedThread();
    const newDocId = await seedGmailDocument(userId, sourceThreadId, NEW_AUTHORED_AT);

    const result = await upsertTriage(
      classifyArgs(userId, sourceThreadId, newDocId, NEW_AUTHORED_AT),
    );

    assert.equal(result.written, true, "the new message's side effects must run");

    const row = await storedRow(userId, sourceThreadId);
    assert.equal(row?.documentId, newDocId, "the reply-draft gate needs the new message's row");
    assert.deepEqual(row.modelVerdict, NEW_VERDICT);
    assert.deepEqual(row.todoSuggestion, NEW_VERDICT.todoSuggestion);
    assert.equal(row.category, "fyi", "the user's tag stays");
    assert.equal(row.source, "user");
    assert.equal(row.overriddenAt?.getTime(), PINNED_AT.getTime());
    assert.equal(row.appliedLabelId, "Label_fyi", "the Gmail label still matches the tag");
  });

  test("a re-run of the pinned message writes nothing", async () => {
    const { userId, sourceThreadId, pinnedDocId } = await seedPinnedThread();
    const prior = await storedRow(userId, sourceThreadId);

    const result = await upsertTriage(
      classifyArgs(userId, sourceThreadId, pinnedDocId, OLD_AUTHORED_AT),
    );

    assert.equal(result.written, false);

    const row = await storedRow(userId, sourceThreadId);
    assert.ok(row);
    assert.equal(row.rowVersion, prior?.rowVersion);
    assert.equal(row.modelVerdict, null);
  });

  test("an older message does not move a pinned row", async () => {
    const { userId, sourceThreadId, pinnedDocId } = await seedPinnedThread();
    const olderAt = new Date("2026-06-27T09:00:00.000Z");
    const olderDocId = await seedGmailDocument(userId, sourceThreadId, olderAt);

    const result = await upsertTriage(classifyArgs(userId, sourceThreadId, olderDocId, olderAt));

    assert.equal(result.written, false);
    assert.equal((await storedRow(userId, sourceThreadId))?.documentId, pinnedDocId);
  });
});
