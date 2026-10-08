/**
 * Outbox to Redis relay. Wakes on `LISTEN events_outbox_new`, with a poll as backstop.
 * At-least-once: publish, then mark published in the same transaction.
 * A crash between them re-publishes, and consumers dedupe by frame `id`.
 */
import pg from "pg";
import { serverEnv } from "@alfred/env/server";
import { isKnownEventKind, type EventFrame } from "@alfred/contracts/events";
import { PeriodicTask } from "./periodic-task";
import { publishFrameToUser } from "./user-events-bus";
import { toMessage } from "@alfred/contracts";

const NOTIFY_CHANNEL = "events_outbox_new";

const BATCH_SIZE = 256;

const BACKSTOP_POLL_MS = 5_000;

const RECONNECT_DELAY_MS = 2_000;

/** Batches per wake, so one busy user cannot starve other work. */
const MAX_BATCHES_PER_WAKE = 64;

let pool: pg.Pool | undefined;

let listenClient: pg.Client | undefined;

interface OutboxRow {
  id: string; // pg returns bigserial as a string
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

    const published: string[] = [];

    for (const row of rows) {
      if (!isKnownEventKind(row.kind)) {
        // Mark it published so it does not loop forever.
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
        // Leave the row for the next pass.
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

/** Drain until a batch comes back short. Check the signal between batches. */
async function drainPass(signal: AbortSignal): Promise<void> {
  let batches = 0;

  while (batches < MAX_BATCHES_PER_WAKE) {
    if (signal.aborted) return;

    const drained = await drainOnce().catch((err) => {
      console.warn("[outbox-relay] drainOnce failed:", toMessage(err));

      return 0;
    });

    batches += 1;

    if (drained < BATCH_SIZE) break;
  }
}

const relay = new PeriodicTask({
  name: "outbox-relay",
  intervalMs: BACKSTOP_POLL_MS,
  // `startListener` triggers the first drain once it listens.
  runOnStart: false,
  pass: drainPass,
});

async function startListener(): Promise<void> {
  listenClient = new pg.Client({ connectionString: serverEnv().DATABASE_URL });
  listenClient.on("error", (err) => {
    console.warn("[outbox-relay] listen client error:", err.message);
  });
  // `trigger()` is a no-op once stopped. The reconnect must check, so it builds no client after shutdown.
  listenClient.on("notification", () => {
    relay.trigger();
  });
  listenClient.on("end", () => {
    if (relay.stopped) return;
    console.warn("[outbox-relay] listen client ended; reconnecting");
    listenClient = undefined;
    setTimeout(() => {
      if (relay.stopped) return;
      void startListener().catch((err) => {
        console.warn("[outbox-relay] reconnect failed:", toMessage(err));
      });
    }, RECONNECT_DELAY_MS);
  });

  await listenClient.connect();
  await listenClient.query(`LISTEN ${NOTIFY_CHANNEL}`);
  relay.trigger();
}

export async function startOutboxRelay(): Promise<void> {
  if (!relay.stopped) return;

  pool = new pg.Pool({
    connectionString: serverEnv().DATABASE_URL,
    max: 4,
    idleTimeoutMillis: 60_000,
  });
  pool.on("error", (err) => {
    console.warn("[outbox-relay] pool error:", err.message);
  });

  // Start before the listener, so its trigger is not a no-op.
  relay.start();
  await startListener();

  console.info("[outbox-relay] started");
}

export async function stopOutboxRelay(): Promise<void> {
  if (relay.stopped) return;

  // Unlisten, then stop the task (it waits for the pass), then close the pool.
  if (listenClient) {
    try {
      await listenClient.query(`UNLISTEN ${NOTIFY_CHANNEL}`);
    } catch {}
  }

  const drained = await relay.stop();

  if (listenClient) {
    await listenClient.end().catch(() => {});
    listenClient = undefined;
  }

  if (pool) {
    if (!drained) console.warn("[outbox-relay] closing pool with a drain still in flight");
    await pool.end().catch(() => {});
    pool = undefined;
  }
}
