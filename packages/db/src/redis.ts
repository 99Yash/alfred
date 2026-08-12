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
 * How a connection behaves when Redis is unreachable, refusing, or accepting
 * but unresponsive. This is the ONLY thing that distinguishes one connection
 * from another here, so it is the parameter rather than a factory name.
 *
 * - `"queue"` — a connection handed to a BullMQ `Queue`/`Worker`/`QueueEvents`
 *   as its `connection:` option. BullMQ hard-requires `maxRetriesPerRequest:
 *   null`, and its blocking reads must survive an outage, so NOTHING on one of
 *   these is bounded. That is not confined to the blocking reads: BullMQ SHARES
 *   the instance it is handed as its non-blocking client, so `queue.add()`'s own
 *   `hset` runs on this connection and an `await queue.add(...)` during an outage
 *   waits indefinitely too. A bound here is not available — BullMQ derives its
 *   blocking client from the same options, and a `commandTimeout` there would
 *   break `BRPOPLPUSH`.
 * - `"command"` — ordinary commands (publish, scratchpad reads and writes, OAuth
 *   state, CVR reads). Keeps the offline queue, so a command issued before the
 *   connection is `ready` still runs once it is, and bounds that wait so the
 *   command always settles. NOT for a connection that subscribes — see below.
 * - `"subscriber"` — a long-lived connection that holds SUBSCRIBE/PSUBSCRIBE
 *   channels. Identical to `"command"` except that it carries no
 *   `commandTimeout`, because a `commandTimeout` on a subscriber KILLS THE
 *   PROCESS: see the `CONNECTION_PROFILES` note below.
 * - `"fail-fast"` — read-through caches, throttles, and one-shot probes, where
 *   the caller has a source of truth to fall back to and would rather be told
 *   NOW than wait. Rejects instead of queueing, which includes rejecting during
 *   the pre-`ready` window right after construction.
 */
export type RedisConnectionKind = "queue" | "command" | "subscriber" | "fail-fast";

/**
 * The whole failure matrix, in one place. Measured against ioredis 5.11.1:
 *
 * - `commandTimeout` is armed in `sendCommand` BEFORE the writable check and
 *   before the offline-queue push, so it bounds a command from the moment the
 *   command is issued — including while the command sits in the offline queue,
 *   and including on a zombie socket that stays writable and never replies.
 *   That is what lets `"command"` keep `enableOfflineQueue: true` and still be
 *   bounded.
 * - `maxRetriesPerRequest` flushes the queues with `MaxRetriesPerRequestError`
 *   from the `close` handler only, and only when it is a NUMBER. With `null`
 *   the queues are never flushed, so an unreachable Redis leaves a command
 *   pending forever — neither resolved nor rejected — and every `try/catch`
 *   around it is dead code. The two options cover disjoint failure shapes:
 *   `maxRetriesPerRequest` gives the accurate typed diagnosis for a
 *   disconnected Redis, `commandTimeout` covers the zombie that never closes.
 * - `enableOfflineQueue: false` rejects whenever the connection is not
 *   writable, and writable requires `status === "ready"`. A command issued in
 *   the same tick as the constructor is ALWAYS not-writable, so `"fail-fast"`
 *   rejects the first command of a lazily-constructed handle even against a
 *   healthy Redis. That is correct for a cache and wrong for everything else,
 *   which is why `"command"` exists as a separate kind.
 * - A `commandTimeout` on a connection that HOLDS SUBSCRIPTIONS crashes the
 *   process, which is why `"subscriber"` exists as a fourth kind. Two measured
 *   steps: (1) a `commandTimeout` is what lets a connection to a peer that
 *   accepts and never replies reach `ready` at all, because it ends the
 *   `CLIENT SETINFO` handshake ioredis sends on every connect; (2) reaching
 *   `ready` runs `readyHandler`, which re-issues the previous SUBSCRIBE and
 *   PSUBSCRIBE with NO `.catch` — unlike the `readonly().catch(noop)` two lines
 *   above it. The next `commandTimeout` on that re-issued command is therefore
 *   an unhandled rejection, and `apps/server/src/index.ts` turns one of those
 *   into `process.exit(1)`. Without a `commandTimeout` the same peer never
 *   reaches `ready`, and a close FROM `ready` parks the in-flight queue in
 *   `prevCommandQueue` for resend instead of rejecting it.
 *
 * `enableReadyCheck: false` is shared: Alfred's Redis is never a replica
 * loading a dataset, and the ready check only delays `ready`.
 */
const CONNECTION_PROFILES: Record<RedisConnectionKind, RedisOptions> = {
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
    // Deliberately no `commandTimeout` — see the fourth note above. The cost is
    // stated rather than hidden: a subscribe or unsubscribe issued against a
    // peer that accepts and never replies is unbounded on this kind. A refusing
    // or unreachable peer, which is the shape that hung boot and shutdown,
    // still rejects through `maxRetriesPerRequest`.
    enableReadyCheck: false,
  },
  "fail-fast": {
    maxRetriesPerRequest: 1,
    enableOfflineQueue: false,
    commandTimeout: 500,
    enableReadyCheck: false,
  },
};

/**
 * The one door to an ioredis client. `new IORedis(...)` appears nowhere else in
 * the repo and `pnpm check` fails on a second one, so every connection in the
 * process carries one of the profiles above.
 *
 * `kind` is required rather than defaulted: a default would let a call site
 * inherit a failure profile it never chose, which is the defect this signature
 * exists to close.
 *
 * @param tracked Push the connection onto the list `closeRedis()` drains.
 *   Default `true`. Pass `false` for a one-shot probe that closes itself in a
 *   `finally` — tracking those would grow the list once per probe.
 */
export function createRedisConnection(
  kind: RedisConnectionKind,
  { tracked = true }: { tracked?: boolean } = {},
): IORedis {
  const url = serverEnv().REDIS_URL;
  const conn = new IORedis(url, { ...CONNECTION_PROFILES[kind] });
  if (tracked) connections.push(conn);
  return conn;
}

/**
 * How long `closeRedis()` waits for a graceful `QUIT` before pulling the socket
 * down. A `QUIT` issued on a disconnected connection whose offline queue is
 * EMPTY resolves immediately, but one issued behind a queued command inherits
 * that command's wait — unbounded on a `"queue"` connection. Shutdown must not
 * be able to hang on a Redis that is already gone.
 */
const QUIT_TIMEOUT_MS = 1_000;

async function closeConnection(conn: IORedis): Promise<void> {
  // Settled eagerly so the graceful path never leaves an unhandled rejection
  // behind when the timeout wins the race below.
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
    // `disconnect()` tears the socket down. It does NOT reliably settle the
    // command the `QUIT` was stuck behind: the queues are flushed from the
    // socket's `close` event, and a connection sitting in `reconnecting` has no
    // live socket to emit one. That is deliberate rather than overlooked — only
    // a `"queue"` connection can hold an unbounded command, the process is on
    // its way out, and shutdown bounding ITSELF is the property that matters.
    if (!quitFinished) conn.disconnect();
  } finally {
    if (timer) clearTimeout(timer);
  }
}

export async function closeRedis(): Promise<void> {
  const open = connections.splice(0, connections.length);
  await Promise.all(open.map(closeConnection));
}
