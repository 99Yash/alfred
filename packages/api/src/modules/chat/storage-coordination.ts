import type { DbTransaction } from "@alfred/db";
import { sql } from "drizzle-orm";

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
      sql`select pg_advisory_xact_lock(hashtextextended(${`chat-storage:${key}`}, 0))`,
    );
  }
}
