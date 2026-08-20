import { databaseEnv } from "@alfred/env/database";
import { POOL_MIN } from "@alfred/env/pool";
import { drizzle } from "drizzle-orm/node-postgres";
import pg from "pg";
import { toMessage } from "@alfred/contracts";

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
    // Saturation is otherwise invisible: an oversubscribed pool doesn't error,
    // it queues, and the added wait is indistinguishable from a slow model
    // (#437). `waitingCount` is the one number that tells the two apart, so say
    // so on the same cadence we already pay for — and only when it's non-zero,
    // which for a correctly sized pool is never.
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

  if (typeof heartbeat === "object" && "unref" in heartbeat) {
    heartbeat.unref();
  }

  _heartbeatTimer = heartbeat;
}

export function db() {
  if (!_db) {
    const env = databaseEnv();
    _pool = new pg.Pool({
      connectionString: env.DATABASE_URL,
      min: POOL_MIN,
      // Derived from `AGENT_WORKER_CONCURRENCY` (#437) — the pool is shared by
      // every worker and every HTTP handler in the process, so its ceiling is a
      // function of how many agent steps can run at once, not a knob of its
      // own. `@alfred/env/pool` owns the derivation and guarantees `>= POOL_MIN`
      // so `warmPool` below can always fill.
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

/** The pool-backed root database client returned by {@link db}. */
export type DbRoot = ReturnType<typeof db>;

/** Query runner shared by pool-backed and checked-out Drizzle clients. */
export type DbSessionRunner = Omit<DbRoot, "$client">;

/**
 * One checked-out database session. Use this only when PostgreSQL state must
 * outlive one statement without opening a transaction (for example, a
 * session-scoped advisory lock around an external call).
 */
export type DbSession = {
  /** Drizzle runner pinned to this physical session. */
  db: DbSessionRunner;
  /** Raw query seam for PostgreSQL session controls. */
  client: Pick<pg.PoolClient, "query">;
};

/**
 * Run work on one physical PostgreSQL session. A failed callback discards the
 * connection so session-local state cannot leak to the next pool borrower.
 */
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
 * A Drizzle transaction handle — the value `db().transaction(cb)` hands its
 * callback. Write helpers accept one so several writes commit atomically in a
 * caller's transaction; omit it and each helper opens its own.
 *
 * A helper that takes `tx?` and spells `tx ? run(tx) : db().transaction(run)`
 * is practicing TRANSACTION REUSE: a caller's open transaction is run on
 * directly, with no savepoint, so a failing body poisons the caller's
 * transaction (its writes stay live, or the transaction aborts on a SQL
 * error). That is the deliberate opposite of `runAtomic`
 * (`@alfred/db/helpers`), which nests under a savepoint and leaves the outer
 * transaction usable. Reaching for `runAtomic` at a reuse site silently flips
 * that failure semantics — convert such a site only as a conscious decision,
 * and note that `packages/assistant/src/knowledge/affiliation.ts` reuses on
 * purpose.
 */
export type DbTransaction = Parameters<Parameters<DbRoot["transaction"]>[0]>[0];

function hasRows(result: unknown): result is { rows: unknown[] } {
  return (
    typeof result === "object" && result !== null && "rows" in result && Array.isArray(result.rows)
  );
}

export function rowsFromExecute<T>(result: unknown): T[] {
  const rawRows = hasRows(result) ? result.rows : result;
  return Array.isArray(rawRows) ? (rawRows as T[]) : [];
}

/**
 * Pre-warm the connection pool so the first requests don't pay
 * the TCP + SSL + auth handshake cost (~2-3 s to Neon).
 * Call once at server startup — best-effort, failures are non-fatal.
 */
export async function warmPool() {
  db(); // ensure pool is created
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
