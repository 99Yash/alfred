import IORedis from 'ioredis';
import { serverEnv } from '@alfred/env/server';

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

export function createUntrackedRedisConnection(): IORedis {
  const url = serverEnv().REDIS_URL;
  return new IORedis(url, {
    maxRetriesPerRequest: null,
    enableReadyCheck: false,
  });
}

export async function closeRedis(): Promise<void> {
  await Promise.all(connections.map((c) => c.quit().catch(() => c.disconnect())));
  connections.length = 0;
}
