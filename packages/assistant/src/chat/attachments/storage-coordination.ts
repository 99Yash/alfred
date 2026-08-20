import { type DbSessionRunner, type DbTransaction, withDbSession } from "@alfred/db";
import { sql } from "drizzle-orm";

function advisoryLockIdentity(storageKey: string): string {
  return `chat-storage:${storageKey}`;
}

/**
 * Serialize durable attachment creation and orphan cleanup for exact storage keys.
 * Sorted acquisition prevents two multi-key operations from deadlocking each other.
 */
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
 * Serialize one storage-key operation without holding an open transaction
 * during object-store I/O. Session and transaction advisory locks share the
 * same PostgreSQL namespace, so uploads still coordinate with turn admission
 * and orphan cleanup across every replica.
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
