import { databaseEnv } from "@alfred/env/database";
import { POOL_MIN } from "@alfred/env/pool";
import { drizzle } from "drizzle-orm/node-postgres";
import { createSchemaFactory } from "drizzle-zod";
import pg from "pg";
import { z } from "zod";
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
      // oxlint-disable-next-line no-console -- @alfred/logging imports @alfred/db, so the pool cannot import the logger.
      console.warn(
        `[db] Pool saturated: ${_pool.waitingCount} waiting, ` +
          `${_pool.totalCount}/${_pool.options.max} connections, ${_pool.idleCount} idle`,
      );
    }

    void _pool.query("SELECT 1").catch((err) => {
      // oxlint-disable-next-line no-console -- @alfred/logging imports @alfred/db, so the pool cannot import the logger.
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
      // oxlint-disable-next-line no-console -- @alfred/logging imports @alfred/db, so the pool cannot import the logger.
      console.warn("[db] Idle pool client error:", err.message);
    });
    startPoolHeartbeat();
    _db = drizzle(_pool);
  }

  return _db;
}

/** The pool `db()` creates. `db()` sets `_pool` and `_db` together, so the throw marks a broken init. */
function initializedPool(): pg.Pool {
  db();

  if (!_pool) throw new Error("[db] db() returned without creating the pool");

  return _pool;
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
  const client = await initializedPool().connect();

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

/**
 * Parse every row of a raw `execute(sql…)` result with `schema`. Throws on the first row that
 * fails, so a drifted query never reaches its caller as a lie.
 *
 * Raw rows skip Drizzle's column mappers: timestamps arrive as text, `bigint`/`numeric` and
 * `count(*)` as text, `integer`/`real` as numbers, and `jsonb` as parsed JSON. Cast in SQL
 * (`count(*)::int`) or coerce in the schema. For whole-table rows, use `createExecuteRowSchema`.
 */
export function rowsFromExecute<S extends z.ZodType>(result: unknown, schema: S): z.output<S>[] {
  const rawRows = hasRows(result) ? result.rows : result;

  if (!Array.isArray(rawRows)) {
    throw new Error("[db] rowsFromExecute: the execute result has no rows array");
  }

  return rawRows.map((row: unknown, index) => {
    const parsed = schema.safeParse(row);

    if (!parsed.success) {
      throw new Error(
        `[db] rowsFromExecute: row ${index} does not match its schema\n${z.prettifyError(parsed.error)}`,
      );
    }

    return parsed.data;
  });
}

/**
 * `createSelectSchema` for rows read through raw `execute(sql…)`. It coerces timestamp text to
 * `Date`, as Drizzle's own mapper does on a typed select. Alias each column to its JS key in SQL.
 */
export const { createSelectSchema: createExecuteRowSchema } = createSchemaFactory({
  coerce: { date: true },
});

/** Open `POOL_MIN` connections at startup so the first requests skip the handshake. Failures are not fatal. */
export async function warmPool() {
  const pool = initializedPool();

  try {
    const clients = await Promise.all(Array.from({ length: POOL_MIN }, () => pool.connect()));

    for (const c of clients) c.release();
  } catch (err) {
    // oxlint-disable-next-line no-console -- @alfred/logging imports @alfred/db, so the pool cannot import the logger.
    console.warn(
      "[db] Pool warm-up failed, connections will be established lazily:",
      toMessage(err),
    );
  }
}

export async function closeConnections() {
  if (_heartbeatTimer) {
    clearInterval(_heartbeatTimer);
    _heartbeatTimer = undefined;
  }

  if (_pool) await _pool.end();
}
