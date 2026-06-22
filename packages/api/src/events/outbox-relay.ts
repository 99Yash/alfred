/**
 * Outbox -> Redis relay.
 *
 * One process-wide loop drains `events_outbox` rows where `published_at IS
 * NULL`, publishes each onto `user-events:u:<userId>`, then stamps
 * `published_at = now()` in the same transaction. Wakes up on Postgres
 * `LISTEN events_outbox_new` plus a periodic backstop in case a NOTIFY is
 * missed (e.g. listener reconnecting).
 *
 * Delivery contract: at-least-once. The publish-then-mark order means a crash
 * after publish but before mark causes the row to be re-published on restart.
 * Consumers dedupe by frame `id`.
 *
 * `FOR UPDATE SKIP LOCKED` lets multiple replicas race safely if we ever scale
 * past one. Today there's only one server replica so it's a no-op cost, but
 * it's free insurance.
 */
import pg from "pg";
import { serverEnv } from "@alfred/env/server";
import { isKnownEventKind, type EventFrame } from "./types";
import { publishFrameToUser } from "./user-events-bus";
import { toMessage } from "@alfred/contracts";

const NOTIFY_CHANNEL = "events_outbox_new";
const BATCH_SIZE = 256;
const BACKSTOP_POLL_MS = 5_000;
const RECONNECT_DELAY_MS = 2_000;

let pool: pg.Pool | undefined;
let listenClient: pg.Client | undefined;
let backstopTimer: ReturnType<typeof setInterval> | undefined;
let drainPending = false;
let drainInFlight = false;
let stopped = true;

interface OutboxRow {
  id: string; // bigserial returns as string in pg
  user_id: string;
  kind: string;
  payload: unknown;
  created_at: Date;
}

async function drainOnce(): Promise<number> {
  if (!pool) return 0;
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const { rows } = await client.query<OutboxRow>(
      `SELECT id, user_id, kind, payload, created_at
         FROM events_outbox
        WHERE published_at IS NULL
        ORDER BY id
        LIMIT $1
        FOR UPDATE SKIP LOCKED`,
      [BATCH_SIZE],
    );

    if (rows.length === 0) {
      await client.query("ROLLBACK");
      return 0;
    }

    // Publish to Redis BEFORE marking published — at-least-once over at-most-once.
    const published: string[] = [];
    for (const row of rows) {
      if (!isKnownEventKind(row.kind)) {
        // Unknown kind made it into the outbox somehow; mark it published so
        // we don't loop forever on it. This shouldn't happen in practice
        // because publishEvent() validates the kind at insert time.
        console.warn("[outbox-relay] dropping unknown kind", row.kind, "id", row.id);
        published.push(row.id);
        continue;
      }
      const frame: EventFrame = {
        id: Number(row.id),
        kind: row.kind,
        payload: row.payload,
        createdAt: row.created_at.toISOString(),
      };
      try {
        await publishFrameToUser(row.user_id, frame);
        published.push(row.id);
      } catch (err) {
        console.warn("[outbox-relay] publish failed for id", row.id, toMessage(err));
        // Don't include in `published` — leave row for next pass.
      }
    }

    if (published.length > 0) {
      await client.query(
        `UPDATE events_outbox SET published_at = now() WHERE id = ANY($1::bigint[])`,
        [published],
      );
    }

    await client.query("COMMIT");
    return rows.length;
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

async function drainLoop(): Promise<void> {
  if (drainInFlight) {
    drainPending = true;
    return;
  }
  drainInFlight = true;
  try {
    do {
      drainPending = false;
      // Keep draining while batches are full — there could be more.
      // Cap at 64 batches per wake to avoid starving other work.
      let batches = 0;
      while (batches < 64) {
        const drained = await drainOnce().catch((err) => {
          console.warn("[outbox-relay] drainOnce failed:", toMessage(err));
          return 0;
        });
        batches += 1;
        if (drained < BATCH_SIZE) break;
      }
    } while (drainPending && !stopped);
  } finally {
    drainInFlight = false;
  }
}

async function startListener(): Promise<void> {
  listenClient = new pg.Client({ connectionString: serverEnv().DATABASE_URL });
  listenClient.on("error", (err) => {
    console.warn("[outbox-relay] listen client error:", err.message);
  });
  listenClient.on("notification", () => {
    if (stopped) return;
    void drainLoop();
  });
  listenClient.on("end", () => {
    if (stopped) return;
    console.warn("[outbox-relay] listen client ended; reconnecting");
    listenClient = undefined;
    setTimeout(() => {
      if (stopped) return;
      void startListener().catch((err) => {
        console.warn("[outbox-relay] reconnect failed:", toMessage(err));
      });
    }, RECONNECT_DELAY_MS);
  });

  await listenClient.connect();
  await listenClient.query(`LISTEN ${NOTIFY_CHANNEL}`);
  // Drain any rows that landed before the listener was up.
  void drainLoop();
}

export async function startOutboxRelay(): Promise<void> {
  if (!stopped) return;
  stopped = false;

  pool = new pg.Pool({
    connectionString: serverEnv().DATABASE_URL,
    max: 4,
    idleTimeoutMillis: 60_000,
  });
  pool.on("error", (err) => {
    console.warn("[outbox-relay] pool error:", err.message);
  });

  await startListener();

  backstopTimer = setInterval(() => {
    if (stopped) return;
    void drainLoop();
  }, BACKSTOP_POLL_MS);
  if (typeof backstopTimer === "object" && "unref" in backstopTimer) {
    backstopTimer.unref();
  }

  console.info("[outbox-relay] started");
}

export async function stopOutboxRelay(): Promise<void> {
  if (stopped) return;
  stopped = true;

  if (backstopTimer) {
    clearInterval(backstopTimer);
    backstopTimer = undefined;
  }

  if (listenClient) {
    try {
      await listenClient.query(`UNLISTEN ${NOTIFY_CHANNEL}`);
    } catch {
      // ignore
    }
    await listenClient.end().catch(() => {});
    listenClient = undefined;
  }

  // Wait for in-flight drain to finish before tearing down the pool.
  // Bound the wait so a stuck drain doesn't block shutdown.
  const deadline = Date.now() + 5_000;
  while (drainInFlight && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 50));
  }

  if (pool) {
    await pool.end().catch(() => {});
    pool = undefined;
  }
}
