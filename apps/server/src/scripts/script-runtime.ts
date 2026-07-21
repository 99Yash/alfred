import { closeConnections, closeRedis } from "@alfred/api/runtime";

type ResourceCloser = () => Promise<unknown> | unknown;

/**
 * Closes script-owned resources before shared infrastructure, continuing when
 * any individual cleanup fails. Pass queue or worker closers in dependency
 * order; Redis and database connections are always closed last.
 */
export async function closeScriptResources(...resourceClosers: ResourceCloser[]): Promise<void> {
  for (const closeResource of [...resourceClosers, closeRedis, closeConnections]) {
    try {
      await closeResource();
    } catch {
      // Cleanup is best-effort so one failed closer cannot strand the rest.
    }
  }
}
