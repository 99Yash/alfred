/**
 * `handlePush` was driven by NO test in this repository until this file.
 *
 * The four sibling suites in this directory drive `handlePull` and the
 * `serverMutators` map directly, so none of them enters `push.ts`. That matters
 * because the push handler owns three behaviors that no mutator body can state
 * and no type can carry: the LMID advances even for a mutation it DROPS, an
 * already-applied mutation is inert on redelivery, and a `clientGroupID` bound
 * to another user is refused before any write.
 *
 * These are characterization tests. They pin what the handler does today, so a
 * later reshape of the mutator registry has something to be measured against.
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

// The fixtures must land before the first `serverEnv()` call in a test body,
// and `serverEnv()` memoizes. The plain form plants no service URL, so it
// cannot hide an absent Postgres or Redis from the guard below.
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

/** The mutation shape the push body carries, with the fields a test varies. */
function mutation(args: { id: number; clientID: string; name: string; args: unknown }): {
  id: number;
  clientID: string;
  name: string;
  args: unknown;
  timestamp: number;
} {
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
      // notes, chat_threads, replicache_client_group and replicache_client all
      // cascade from user.
      await db().delete(user).where(inArray(user.id, createdUserIds));
    }
    await closeRedis();
    await closeConnections();
  });

  test("each dropped mutation still advances its own client's LMID and writes no row", async () => {
    const userId = await seedUser();
    const clientGroupID = `${ID_PREFIX}g-${randomUUID()}`;
    // Each mutation the handler DROPS gets its own client, so its LMID advance
    // is observable on its own. A single shared client would hide both drops:
    // the last applied mutation raises the LMID past them either way, and the
    // assertion would pass with both drop branches deleted.
    const appliedClient = `${ID_PREFIX}c-applied-${randomUUID()}`;
    const unknownClient = `${ID_PREFIX}c-unknown-${randomUUID()}`;
    const invalidClient = `${ID_PREFIX}c-invalid-${randomUUID()}`;
    const firstNoteId = `${ID_PREFIX}n1-${randomUUID()}`;
    const lastNoteId = `${ID_PREFIX}n2-${randomUUID()}`;
    const droppedNoteId = `${ID_PREFIX}n3-${randomUUID()}`;

    // One batch, four mutations: applied, unknown name, invalid args, applied.
    // The two dropped ones can never apply, so the handler advances their LMID
    // anyway and the client stops re-queueing them.
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
          // `text` is required by `noteCreateArgsSchema`; this fails safeParse.
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

    // `chatThreadRename` writes its title unconditionally, so it is NOT
    // idempotent through a conflict clause. That makes it the right probe: if
    // the replay reached the mutator body, the title below would change back.
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
