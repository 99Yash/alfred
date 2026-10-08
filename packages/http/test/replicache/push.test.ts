/**
 * Characterization tests for `handlePush`, which no other suite enters. The handler owns
 * three behaviors no mutator or type states: the LMID advances for a dropped mutation,
 * a redelivered mutation is inert, and a `clientGroupID` bound to another user is refused.
 */

import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, describe, test } from "node:test";

import { closeConnections, db } from "@alfred/db";
import { closeRedis } from "@alfred/db/redis";
import {
  chatThreads,
  notes,
  replicacheClient,
  replicacheClientGroup,
  user,
} from "@alfred/db/schemas";
import { and, eq, inArray } from "drizzle-orm";

import { handlePush } from "../../src/sync/push";
import { dbBackedSkip } from "../support/db-backed";
import { applyServerEnvFixtures } from "../support/server-env";

// `serverEnv()` memoizes, so seed first. The plain form plants no service URL.
applyServerEnvFixtures();

const SKIP = dbBackedSkip("database+redis");

const ID_PREFIX = "test-rpush-";

const createdUserIds: string[] = [];

async function seedUser(): Promise<string> {
  const userId = `${ID_PREFIX}${randomUUID()}`;
  createdUserIds.push(userId);
  await db()
    .insert(user)
    .values({ id: userId, name: "Test User", email: `${userId}@example.test` });

  return userId;
}

interface RecordedMutation {
  id: number;
  clientID: string;
  name: string;
  args: unknown;
  timestamp: number;
}

function mutation(args: {
  id: number;
  clientID: string;
  name: string;
  args: unknown;
}): RecordedMutation {
  return { ...args, timestamp: 1 };
}

async function lastMutationId(clientID: string): Promise<number> {
  const [row] = await db()
    .select({ lmid: replicacheClient.lastMutationId })
    .from(replicacheClient)
    .where(eq(replicacheClient.id, clientID));

  return row?.lmid ?? 0;
}

describe("handlePush LMID, replay and ownership (DB-backed)", { skip: SKIP }, () => {
  after(async () => {
    if (createdUserIds.length) {
      // Notes, chat threads, and Replicache client rows cascade from user.
      await db().delete(user).where(inArray(user.id, createdUserIds));
    }

    await closeRedis();
    await closeConnections();
  });

  test("each dropped mutation still advances its own client's LMID and writes no row", async () => {
    const userId = await seedUser();
    const clientGroupID = `${ID_PREFIX}g-${randomUUID()}`;
    // One client per dropped mutation: with a shared client, the last applied one hides both drops.
    const appliedClient = `${ID_PREFIX}c-applied-${randomUUID()}`;
    const unknownClient = `${ID_PREFIX}c-unknown-${randomUUID()}`;
    const invalidClient = `${ID_PREFIX}c-invalid-${randomUUID()}`;
    const firstNoteId = `${ID_PREFIX}n1-${randomUUID()}`;
    const lastNoteId = `${ID_PREFIX}n2-${randomUUID()}`;
    const droppedNoteId = `${ID_PREFIX}n3-${randomUUID()}`;

    // Applied, unknown name, invalid args, applied. Drops advance the LMID so the client stops retrying.
    const result = await handlePush(userId, {
      pushVersion: 1,
      clientGroupID,
      mutations: [
        mutation({
          id: 1,
          clientID: appliedClient,
          name: "noteCreate",
          args: {
            id: firstNoteId,
            userId,
            text: "first",
            createdAt: new Date().toISOString(),
          },
        }),
        mutation({ id: 1, clientID: unknownClient, name: "thisMutatorDoesNotExist", args: {} }),
        mutation({
          id: 1,
          clientID: invalidClient,
          name: "noteCreate",
          // No `text`, so `noteCreateArgsSchema` rejects it.
          args: { id: droppedNoteId, userId, createdAt: new Date().toISOString() },
        }),
        mutation({
          id: 2,
          clientID: appliedClient,
          name: "noteCreate",
          args: {
            id: lastNoteId,
            userId,
            text: "last",
            createdAt: new Date().toISOString(),
          },
        }),
      ],
    });

    assert.deepEqual(result, {}, "a push by the owning user is not forbidden");
    assert.equal(await lastMutationId(appliedClient), 2, "both applied mutations advance the LMID");
    assert.equal(
      await lastMutationId(unknownClient),
      1,
      "an unknown mutator name advances the LMID",
    );
    assert.equal(await lastMutationId(invalidClient), 1, "invalid args advance the LMID");

    const rows = await db().select({ id: notes.id }).from(notes).where(eq(notes.userId, userId));
    assert.deepEqual(
      rows.map((r) => r.id).sort(),
      [firstNoteId, lastNoteId].sort(),
      "only the two valid mutations wrote a row",
    );
  });

  test("redelivering an applied batch re-runs no mutator body and does not move the LMID", async () => {
    const userId = await seedUser();
    const clientGroupID = `${ID_PREFIX}g-${randomUUID()}`;
    const clientID = `${ID_PREFIX}c-${randomUUID()}`;
    const threadId = `${ID_PREFIX}t-${randomUUID()}`;

    // `chatThreadRename` is not idempotent, so a replay that reached it would reset the title.
    const batch = {
      pushVersion: 1 as const,
      clientGroupID,
      mutations: [
        mutation({
          id: 1,
          clientID,
          name: "chatThreadCreate",
          args: { id: threadId, userId, createdAt: new Date().toISOString() },
        }),
        mutation({
          id: 2,
          clientID,
          name: "chatThreadRename",
          args: { id: threadId, userId, title: "pushed title" },
        }),
      ],
    };

    assert.deepEqual(await handlePush(userId, batch), {});
    assert.equal(await lastMutationId(clientID), 2);

    // Stand in for any later server-side write to the same row.
    await db()
      .update(chatThreads)
      .set({ title: "written after the push" })
      .where(and(eq(chatThreads.id, threadId), eq(chatThreads.userId, userId)));

    assert.deepEqual(await handlePush(userId, batch), {}, "a redelivered batch is accepted");
    assert.equal(await lastMutationId(clientID), 2, "the LMID does not move on a replay");

    const [thread] = await db()
      .select({ title: chatThreads.title })
      .from(chatThreads)
      .where(eq(chatThreads.id, threadId));

    assert.equal(
      thread?.title,
      "written after the push",
      "the replayed rename never reached the mutator body",
    );
  });

  test("a client group bound to another user is refused and writes nothing", async () => {
    const ownerId = await seedUser();
    const intruderId = await seedUser();
    const clientGroupID = `${ID_PREFIX}g-${randomUUID()}`;
    const clientID = `${ID_PREFIX}c-${randomUUID()}`;
    const noteId = `${ID_PREFIX}n-${randomUUID()}`;

    await db()
      .insert(replicacheClientGroup)
      .values({ id: clientGroupID, userId: ownerId, cvrVersion: 0 });

    const result = await handlePush(intruderId, {
      pushVersion: 1,
      clientGroupID,
      mutations: [
        mutation({
          id: 1,
          clientID,
          name: "noteCreate",
          args: {
            id: noteId,
            userId: intruderId,
            text: "stolen",
            createdAt: new Date().toISOString(),
          },
        }),
      ],
    });

    assert.deepEqual(result, { forbidden: true });
    assert.equal(await lastMutationId(clientID), 0, "a refused push advances no LMID");

    const rows = await db()
      .select({ id: notes.id })
      .from(notes)
      .where(eq(notes.userId, intruderId));

    assert.deepEqual(rows, [], "a refused push writes no row");
  });
});
