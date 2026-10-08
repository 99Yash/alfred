import IORedis, { type RedisOptions } from "ioredis";
import { serverEnv } from "@alfred/env/server";

export function isQueueEnabled(): boolean {
  try {
    return Boolean(serverEnv().REDIS_URL);
  } catch {
    return false;
  }
}

const connections: IORedis[] = [];

/**
 * What a connection does when Redis is unreachable, refusing, or silent.
 *
 * - `"queue"`: for BullMQ `connection:`. Nothing is bounded. BullMQ requires
 *   `maxRetriesPerRequest: null`, and it shares this connection for its own
 *   writes, so `await queue.add(...)` also waits through an outage.
 *   A `commandTimeout` would break its `BRPOPLPUSH`.
 * - `"command"`: ordinary commands. Keeps the offline queue, so a command sent
 *   before `ready` still runs, and bounds the wait. Do not subscribe on it.
 * - `"subscriber"`: holds SUBSCRIBE channels. Like `"command"` but with no
 *   `commandTimeout` and with auto-resubscribe off. The owner must re-subscribe
 *   on `conn.on("ready")` (see `packages/assistant/src/realtime/replicache-events.ts`).
 * - `"fail-fast"`: rejects every command sent before `ready`, so the first
 *   command after a lazy construction fails even on a healthy Redis. Use it only
 *   if the caller can get the answer from another store, or reads the key again
 *   on a schedule and fails open meanwhile. A throttle, a rate counter, a one-shot
 *   flag, or a health probe must use `"command"`. Judge the caller, not the key
 *   (see `packages/assistant/src/chat/stop-signal.ts`).
 */
export type RedisConnectionKind = "queue" | "command" | "subscriber" | "fail-fast";

/**
 * Measured against ioredis 5.11.1:
 *
 * - `commandTimeout` starts when the command is sent, so it also bounds time in
 *   the offline queue and on a socket that never replies.
 * - `maxRetriesPerRequest` flushes pending commands on `close` only when it is a
 *   number. With `null`, a command to a dead Redis never settles.
 * - `enableOfflineQueue: false` rejects until `status === "ready"`.
 * - Auto-resubscribe re-sends SUBSCRIBE after a reconnect with no `.catch`. If it
 *   rejects (from `commandTimeout`, or from a numeric `maxRetriesPerRequest` when
 *   the peer refuses), the unhandled rejection exits the process
 *   (`apps/server/src/index.ts`). So `"subscriber"` turns it off.
 *
 * `enableReadyCheck: false`: Alfred's Redis is never a replica that loads a dataset.
 */
const CONNECTION_PROFILES = {
  queue: {
    maxRetriesPerRequest: null,
    enableOfflineQueue: true,
    enableReadyCheck: false,
  },
  command: {
    maxRetriesPerRequest: 3,
    enableOfflineQueue: true,
    commandTimeout: 2_000,
    enableReadyCheck: false,
  },
  subscriber: {
    maxRetriesPerRequest: 3,
    enableOfflineQueue: true,
    // No `commandTimeout`, so a subscribe to a silent peer is unbounded.
    autoResubscribe: false,
    enableReadyCheck: false,
  },
  "fail-fast": {
    maxRetriesPerRequest: 1,
    enableOfflineQueue: false,
    commandTimeout: 500,
    enableReadyCheck: false,
  },
} satisfies Record<RedisConnectionKind, RedisOptions>;

/** An ioredis client without the subscribe verbs. A subscription on a bounded profile can exit the process. */
export type BoundedRedis = Omit<IORedis, "subscribe" | "psubscribe" | "ssubscribe">;

/**
 * The one verb the scripts below need. Not `Pick<BoundedRedis, "eval">`, because
 * the `eval` overloads make a test double impossible without a cast.
 */
export type EvalRedis = {
  eval(script: string, numkeys: number, ...args: (string | number)[]): Promise<unknown>;
};

/**
 * Increment a counter and set its TTL in one atomic step, so a crash cannot
 * leave a key with no TTL. Sets the TTL only on a new key or a key without a TTL,
 * so a fixed window does not slide.
 */
const INCR_WITH_TTL_SCRIPT = `local count = redis.call("INCRBY", KEYS[1], ARGV[1])
if count == tonumber(ARGV[1]) or redis.call("TTL", KEYS[1]) == -1 then
  redis.call("EXPIRE", KEYS[1], ARGV[2])
end
return count`;

export async function incrementExpiringCounter(
  redis: EvalRedis,
  key: string,
  amount: number,
  ttlSeconds: number,
): Promise<number> {
  const result = await redis.eval(INCR_WITH_TTL_SCRIPT, 1, key, amount, ttlSeconds);

  return Number(result);
}

/**
 * GCRA pacing. A counter says "may I go now?"; this says "when may I go?", so
 * an over-limit caller waits instead of failing.
 *
 * The key holds the time the queue is empty again (TAT). Each reservation moves
 * it one `intervalMs` later. An idle bucket lets `burst + 1` callers go at once.
 * A caller whose wait is past `maxWaitMs` does not move the TAT. If it did, the
 * mark would run ahead of a queue that no longer exists.
 *
 * "Now" comes from Redis `TIME`, so a process with a fast clock cannot push the
 * shared mark forward. `PX` on every write lets an idle bucket expire.
 */
const RESERVE_SLOT_SCRIPT = `local interval = tonumber(ARGV[1])
local burst = tonumber(ARGV[2])
local ttlMs = tonumber(ARGV[3])
local maxWaitMs = tonumber(ARGV[4])
local time = redis.call("TIME")
local now = (tonumber(time[1]) * 1000) + math.floor(tonumber(time[2]) / 1000)
local tat = tonumber(redis.call("GET", KEYS[1]) or "0")
if tat < now then tat = now end
local wait = tat - (burst * interval) - now
if wait < 0 then wait = 0 end
if wait > maxWaitMs then return math.floor(wait) end
redis.call("SET", KEYS[1], tat + interval, "PX", ttlMs)
return math.floor(wait)`;

/**
 * Milliseconds to sleep before using the reserved slot. Zero means go now.
 * A wait past `maxWaitMs` comes back without a reservation.
 */
export async function reserveRateSlot(
  redis: EvalRedis,
  key: string,
  intervalMs: number,
  burst: number,
  maxWaitMs: number,
): Promise<number> {
  // Burst window plus the longest honored wait, plus a minute of slack.
  const ttlMs = intervalMs * (burst + 1) + maxWaitMs + 60_000;

  const result = await redis.eval(RESERVE_SLOT_SCRIPT, 1, key, intervalMs, burst, ttlMs, maxWaitMs);

  return Number(result);
}

/**
 * The only way to build an ioredis client (`pnpm check` rejects `new IORedis`).
 * `kind` has no default, so each call site picks its outage behavior.
 * Every connection is tracked so `closeRedis()` can close it.
 */
export function createRedisConnection(kind: "command" | "fail-fast"): BoundedRedis;
export function createRedisConnection(kind: "queue" | "subscriber"): IORedis;
export function createRedisConnection(kind: RedisConnectionKind): IORedis;
export function createRedisConnection(kind: RedisConnectionKind): IORedis {
  const url = serverEnv().REDIS_URL;
  const conn = new IORedis(url, { ...CONNECTION_PROFILES[kind] });
  connections.push(conn);

  return conn;
}

/** A `QUIT` behind a queued command waits as long as that command, so shutdown caps it. */
const QUIT_TIMEOUT_MS = 1_000;

async function closeConnection(conn: IORedis): Promise<void> {
  // Settle now so a lost race leaves no unhandled rejection.
  const quit = conn.quit().then(
    () => true,
    () => false,
  );

  let timer: ReturnType<typeof setTimeout> | undefined;

  try {
    const quitFinished = await Promise.race([
      quit,
      new Promise<false>((resolve) => {
        timer = setTimeout(() => resolve(false), QUIT_TIMEOUT_MS);
      }),
    ]);

    // This may leave a stuck `"queue"` command unsettled. Shutdown only needs to finish.
    if (!quitFinished) conn.disconnect();
  } finally {
    if (timer) clearTimeout(timer);
  }
}

export async function closeRedis(): Promise<void> {
  const open = connections.splice(0, connections.length);
  await Promise.all(open.map(closeConnection));
}
