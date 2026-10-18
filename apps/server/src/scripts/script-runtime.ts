import { closeConnections } from "@alfred/db";
import { closeRedis } from "@alfred/db/redis";

/** A closer may return a promise; `closeScriptResources` awaits whatever it returns. */
type ResourceCloser = () => unknown;

/** Run each closer in order, then Redis and the DB. One failure does not stop the rest. */
export async function closeScriptResources(...resourceClosers: ResourceCloser[]): Promise<void> {
  for (const closeResource of [...resourceClosers, closeRedis, closeConnections]) {
    try {
      await closeResource();
    } catch {
      // Best effort.
    }
  }
}
