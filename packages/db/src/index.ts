import { databaseEnv } from "@alfred/env/database";
import { POOL_MIN } from "@alfred/env/pool";
import { drizzle } from "drizzle-orm/node-postgres";
import pg from "pg";
import { toMessage, unrefTimer } from "@alfred/contracts";

const POOL_IDLE_TIMEOUT_MS = 5 * 60_000;

const POOL_CONNECTION_TIMEOUT_MS = 10_000;

const POOL_HEARTBEAT_INTERVAL_MS = 20_000;

let _db: ReturnType<typeof drizzle> | undefined;

let _pool: pg.Pool | undefined;

let _heartbeatTimer: ReturnType<typeof setInterval> | undefined;

function startPoolHeartbeat() {
  if (_heartbeatTimer || !_pool) return;

  const heartbeat = setInterval(() => {
    if (!_pool) return;

    // A full pool queues instead of failing, which looks like a slow model.
    // `waitingCount` is the only sign.
    if (_pool.waitingCount > 0) {
      console.warn(
        `[db] Pool saturated: ${_pool.waitingCount} waiting, ` +
          `${_pool.totalCount}/${_pool.options.max} connections, ${_pool.idleCount} idle`,
      );
    }

    void _pool.query("SELECT 1").catch((err) => {
      console.warn("[db] Pool heartbeat failed:", toMessage(err));
    });
  }, POOL_HEARTBEAT_INTERVAL_MS);

  unrefTimer(heartbeat);

  _heartbeatTimer = heartbeat;
}

export function db() {
  if (!_db) {
    const env = databaseEnv();
    _pool = new pg.Pool({
      connectionString: env.DATABASE_URL,
      min: POOL_MIN,
      // Derived from `AGENT_WORKER_CONCURRENCY` and never below `POOL_MIN`, so `warmPool` can fill.
      max: env.DB_POOL_MAX,
      idleTimeoutMillis: POOL_IDLE_TIMEOUT_MS,
      connectionTimeoutMillis: POOL_CONNECTION_TIMEOUT_MS,
      keepAlive: true,
      keepAliveInitialDelayMillis: 10_000,
    });
    _pool.on("error", (err) => {
      console.warn("[db] Idle pool client error:", err.message);
    });
    startPoolHeartbeat();
    _db = drizzle(_pool);
  }

  return _db;
}

export type DbRoot = ReturnType<typeof db>;

/** Query runner shared by pool-backed and checked-out Drizzle clients. */
export type DbSessionRunner = Omit<DbRoot, "$client">;

/**
 * One checked-out connection. Use it only when session state must outlive one statement
 * without a transaction, such as an advisory lock around an external call.
 */
export type DbSession = {
  db: DbSessionRunner;
  client: Pick<pg.PoolClient, "query">;
};

/** Run work on one connection. On a throw, discard the connection so its session state cannot leak. */
export async function withDbSession<T>(body: (session: DbSession) => Promise<T>): Promise<T> {
  db();
  const client = await _pool!.connect();

  try {
    const result = await body({ db: drizzle(client), client });
    client.release();

    return result;
  } catch (err) {
    client.release(true);
    throw err;
  }
}

/**
 * The handle `db().transaction(cb)` passes to its callback.
 * `tx ? run(tx) : db().transaction(run)` reuses the caller's transaction with no savepoint,
 * so a failure poisons it. `runAtomic` uses a savepoint instead. Do not swap one for the other
 * without thought: `packages/assistant/src/knowledge/affiliation.ts` reuses on purpose.
 */
export type DbTransaction = Parameters<Parameters<DbRoot["transaction"]>[0]>[0];

function hasRows(result: unknown): result is { rows: unknown[] } {
  return (
    typeof result === "object" && result !== null && "rows" in result && Array.isArray(result.rows)
  );
}

export function rowsFromExecute<T>(result: unknown): T[] {
  const rawRows = hasRows(result) ? result.rows : result;

  // SAFETY: the driver returns untyped rows. The caller names the row type for its query.
  return Array.isArray(rawRows) ? (rawRows as T[]) : [];
}

/** Open `POOL_MIN` connections at startup so the first requests skip the handshake. Failures are not fatal. */
export async function warmPool() {
  db(); // creates the pool

  if (_pool) {
    try {
      const clients = await Promise.all(Array.from({ length: POOL_MIN }, () => _pool!.connect()));

      for (const c of clients) c.release();
    } catch (err) {
      console.warn(
        "[db] Pool warm-up failed, connections will be established lazily:",
        toMessage(err),
      );
    }
  }
}

export async function closeConnections() {
  if (_heartbeatTimer) {
    clearInterval(_heartbeatTimer);
    _heartbeatTimer = undefined;
  }

  if (_pool) await _pool.end();
}
