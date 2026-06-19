import IORedis from "ioredis";
import { serverEnv } from "@alfred/env/server";

export function isQueueEnabled(): boolean {
  try {
    return Boolean(serverEnv().REDIS_URL);
  } catch {
    return false;
  }
}

const connections: IORedis[] = [];

export function createRedisConnection(): IORedis {
  const url = serverEnv().REDIS_URL;
  const conn = new IORedis(url, {
    maxRetriesPerRequest: null,
    enableReadyCheck: false,
  });
  connections.push(conn);
  return conn;
}

/**
 * Untracked, fail-fast connection for one-shot probes (e.g. the `/ready`
 * readiness check). Not added to `connections`, so the caller MUST close it
 * itself (in a `finally`). `enableOfflineQueue: false` + `commandTimeout` make
 * a `ping` against a down/flapping Redis reject promptly instead of queueing
 * and waiting forever for reconnect — otherwise each failing probe would leak a
 * perpetually-reconnecting socket precisely when Redis is already unhealthy.
 */
export function createUntrackedRedisConnection(): IORedis {
  const url = serverEnv().REDIS_URL;
  return new IORedis(url, {
    maxRetriesPerRequest: 1,
    enableReadyCheck: false,
    enableOfflineQueue: false,
    commandTimeout: 500,
  });
}

/**
 * Cache-style connection that fails FAST instead of queueing when Redis is down,
 * so a read-through cache degrades to its source of truth (Postgres) rather than
 * hanging the caller. The BullMQ connections above use `enableOfflineQueue: true`
 * (the default) + `maxRetriesPerRequest: null`, which makes commands issued while
 * disconnected wait forever for reconnect — correct for a job queue, fatal for a
 * per-request cache read on the hot path. Here `enableOfflineQueue: false` makes
 * commands reject immediately while disconnected and `commandTimeout` bounds a
 * slow/flapping connection. Callers MUST wrap reads/writes in try/catch and fall
 * back to the source of truth.
 */
export function createCacheRedisConnection(): IORedis {
  const url = serverEnv().REDIS_URL;
  const conn = new IORedis(url, {
    enableReadyCheck: false,
    enableOfflineQueue: false,
    commandTimeout: 500,
    maxRetriesPerRequest: 1,
  });
  connections.push(conn);
  return conn;
}

export async function closeRedis(): Promise<void> {
  await Promise.all(connections.map((c) => c.quit().catch(() => c.disconnect())));
  connections.length = 0;
}
