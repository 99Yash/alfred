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
 *   `commandTimeout` and switches ioredis's auto-resubscribe OFF, because the
 *   command ioredis re-issues for itself after a reconnect is the one command
 *   on the connection that nothing catches, and an uncaught rejection is
 *   `process.exit(1)`: see the `CONNECTION_PROFILES` note below. THE OWNER OF
 *   THE CONNECTION MUST RE-SUBSCRIBE ITSELF on `conn.on("ready")` — a reconnect
 *   drops every server-side subscription and nothing else will re-issue it.
 *   `packages/assistant/src/realtime/replicache-events.ts` is the worked
 *   example.
 * - `"fail-fast"` — the kind with a precondition, so read the cost before the
 *   benefit. `enableOfflineQueue: false` rejects every command issued while the
 *   connection is not yet `ready`, so the FIRST command after each lazy
 *   construction is rejected even by a perfectly healthy Redis. THE DECISION
 *   TEST, and a caller qualifies by EITHER answer:
 *   1. Can this caller answer the same question from another store? Then the
 *      rejection costs nothing, because the caller reads the other store and
 *      moves on. A read-through cache over a Postgres table passes this way.
 *   2. Does this caller read the same key AGAIN on a schedule, and does it fail
 *      OPEN meanwhile, on a path where waiting costs more than missing? Then the
 *      rejection costs one read and the next read corrects it. The chat-stop
 *      poll passes this way: it runs inside the model stream loop, which awaits
 *      it, so a bounded wait would stall streaming for the whole outage where a
 *      rejection stalls nothing.
 *   A throttle claim, a rate counter, a ONE-SHOT flag read and a health probe
 *   all fail BOTH tests — the Redis key IS their source of truth and they get no
 *   second read, so `"fail-fast"` silently drops the first request of every
 *   process. Those callers take `"command"`, which waits for `ready` and still
 *   bounds the wait. Read the CALLER, never the verb or the key: one key can
 *   carry a one-shot reader and a polling reader, and they take different kinds
 *   (`packages/assistant/src/conversations/stop-signal.ts` is the worked
 *   example). Do not read "caches, throttles, and probes" as a list of eligible
 *   shapes; two of those three were wrong here (#127).
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
 * - `autoResubscribe` is the reason `"subscriber"` exists as a fourth kind.
 *   After a reconnect, `readyHandler` re-issues the previous SUBSCRIBE,
 *   PSUBSCRIBE and SSUBSCRIBE with NO `.catch` — unlike the
 *   `readonly().catch(noop)` a few lines above it in the same function. That is
 *   the only command on such a connection that no module owns, so ANY rejection
 *   of it is an unhandled rejection, and `apps/server/src/index.ts` turns one of
 *   those into `process.exit(1)`. Two measured routes reach that rejection, and
 *   removing either one alone leaves the other: (1) a `commandTimeout` times the
 *   re-issued command out — and a `commandTimeout` is also what lets a
 *   connection to a peer that accepts and never replies reach `ready` in the
 *   first place, because it ends the `CLIENT SETINFO` handshake ioredis sends on
 *   every connect; (2) a numeric `maxRetriesPerRequest` flushes the re-issued
 *   command with `MaxRetriesPerRequestError` when the peer then refuses —
 *   `prevCommandQueue = self.commandQueue` in the close handler is an ALIAS, not
 *   a move, and only a TCP `connect` calls `resetCommandQueue()`, which a
 *   refusing peer never emits. `"subscriber"` therefore drops the
 *   `commandTimeout` AND sets `autoResubscribe: false`, which deletes the
 *   uncaught command itself rather than the two ways it can fail. The cost is
 *   that re-subscription becomes the connection owner's job on `ready`.
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
    // Deliberately no `commandTimeout`, and ioredis's own re-subscribe switched
    // off — see the fourth note above. Two costs, stated rather than hidden:
    // (a) a subscribe or unsubscribe issued against a peer that accepts and
    // never replies is unbounded on this kind (a refusing or unreachable peer,
    // which is the shape that hung boot and shutdown, still rejects through
    // `maxRetriesPerRequest`); (b) the owner MUST re-subscribe on `ready`,
    // because nothing else does now.
    autoResubscribe: false,
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
 * An ioredis client with the subscribe verbs taken away.
 *
 * Holding a subscription on a connection whose profile carries a
 * `commandTimeout` and ioredis's auto-resubscribe is the exact mistake that
 * ends in `process.exit(1)` (see the note above), and it is a mistake nothing
 * used to catch: the factory handed back the same `IORedis` for every kind, so
 * `.subscribe()` sat in autocomplete on a `"command"` handle. All three
 * subscriber handles in this repo were written that way first, by an author
 * holding the whole design, and `pnpm check`, `pnpm check-types` and two
 * mutation probes all passed over it. Removing the verbs from the type turns
 * that into TS2339 at the call site.
 */
export type BoundedRedis = Omit<IORedis, "subscribe" | "psubscribe" | "ssubscribe">;

/**
 * The one door to an ioredis client. `new IORedis(...)` appears nowhere else in
 * the repo and `pnpm check` fails on a second one, so every connection in the
 * process carries one of the profiles above.
 *
 * `kind` is required rather than defaulted: a default would let a call site
 * inherit a failure profile it never chose, which is the defect this signature
 * exists to close.
 *
 * The bounded kinds return {@link BoundedRedis}, so a handle that must not
 * subscribe cannot. The third overload exists for a caller that holds the kind
 * as a VALUE rather than a literal — only the test fixtures do — and it is the
 * reason this lever is tier 1 for every real call site and tier 3 for those:
 * overload resolution takes the first match, so a literal `"command"` can never
 * reach it.
 *
 * Every connection this returns is pushed onto the list `closeRedis()` drains.
 * There used to be a `{ tracked: false }` opt-out for a one-shot probe that
 * closed itself in a `finally`; its only caller was `/ready`, which now holds
 * one long-lived connection instead of building one per request (#127). An
 * untracked connection is a connection shutdown cannot close, so the opt-out is
 * deleted rather than left available.
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
