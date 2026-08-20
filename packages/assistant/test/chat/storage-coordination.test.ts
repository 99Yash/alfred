import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, describe, test } from "node:test";

import { lockChatStorageKeys, withChatStorageKeyLock } from "@alfred/assistant/chat";
import { closeConnections, db } from "@alfred/db";
import { pgErrorChain } from "@alfred/db/pg-errors";
import { sql } from "drizzle-orm";

import { dbBackedSkip } from "../support/db-backed";

const SKIP = dbBackedSkip("database");
const PG_LOCK_NOT_AVAILABLE = "55P03";

describe("chat storage-key coordination (DB-backed)", { skip: SKIP }, () => {
  after(async () => {
    await closeConnections();
  });

  test("serializes the same storage key across database sessions", async () => {
    const storageKey = `chat/test/thread/message/${randomUUID()}-report.pdf`;
    const firstLocked = Promise.withResolvers<void>();
    const releaseFirst = Promise.withResolvers<void>();

    const firstTransaction = db().transaction(async (tx) => {
      await lockChatStorageKeys(tx, [storageKey]);
      firstLocked.resolve();
      await releaseFirst.promise;
    });
    await firstLocked.promise;

    try {
      await assert.rejects(
        db().transaction(async (tx) => {
          await tx.execute(sql`set local lock_timeout = '100ms'`);
          await lockChatStorageKeys(tx, [storageKey]);
        }),
        (error: unknown) => {
          assert.equal(
            [...pgErrorChain(error)].some((entry) => entry.code === PG_LOCK_NOT_AVAILABLE),
            true,
          );
          return true;
        },
      );
    } finally {
      releaseFirst.resolve();
      await firstTransaction;
    }

    await assert.doesNotReject(
      db().transaction(async (tx) => {
        await lockChatStorageKeys(tx, [storageKey]);
      }),
    );
  });

  test("session upload lock coordinates with transaction cleanup lock", async () => {
    const storageKey = `chat/test/thread/message/${randomUUID()}-report.pdf`;
    const sessionLocked = Promise.withResolvers<void>();
    const releaseSession = Promise.withResolvers<void>();

    const upload = withChatStorageKeyLock(storageKey, async () => {
      sessionLocked.resolve();
      await releaseSession.promise;
    });
    await sessionLocked.promise;

    try {
      await assert.rejects(
        db().transaction(async (tx) => {
          await tx.execute(sql`set local lock_timeout = '100ms'`);
          await lockChatStorageKeys(tx, [storageKey]);
        }),
        (error: unknown) => {
          assert.equal(
            [...pgErrorChain(error)].some((entry) => entry.code === PG_LOCK_NOT_AVAILABLE),
            true,
          );
          return true;
        },
      );
    } finally {
      releaseSession.resolve();
      await upload;
    }
  });
});
