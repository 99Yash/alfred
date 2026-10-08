import { type DbSessionRunner, type DbTransaction, withDbSession } from "@alfred/db";
import { sql } from "drizzle-orm";

function advisoryLockIdentity(storageKey: string): string {
  return `chat-storage:${storageKey}`;
}

/** Serialize attachment creation and orphan cleanup per key. Sorted order prevents deadlock. */
export async function lockChatStorageKeys(
  tx: DbTransaction,
  storageKeys: readonly string[],
): Promise<void> {
  const keys = [...new Set(storageKeys)].sort();

  for (const key of keys) {
    await tx.execute(
      sql`select pg_advisory_xact_lock(hashtextextended(${advisoryLockIdentity(key)}, 0))`,
    );
  }
}

/**
 * Lock one key without an open transaction during object-store I/O. Session and
 * transaction advisory locks share one namespace, so this still excludes admission and cleanup.
 */
export async function withChatStorageKeyLock<T>(
  storageKey: string,
  body: (runner: DbSessionRunner) => Promise<T>,
): Promise<T> {
  return withDbSession(async (session) => {
    const identity = advisoryLockIdentity(storageKey);
    await session.client.query("select pg_advisory_lock(hashtextextended($1, 0))", [identity]);

    try {
      return await body(session.db);
    } finally {
      await session.client.query("select pg_advisory_unlock(hashtextextended($1, 0))", [identity]);
    }
  });
}
