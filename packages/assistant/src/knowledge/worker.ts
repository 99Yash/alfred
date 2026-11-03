import { user as userTable } from "@alfred/db/schemas";
import { embed } from "@alfred/ai/embeddings";
import { db } from "@alfred/db";
import { scheduledFireTime } from "@alfred/assistant/execution";
import { toMessage } from "@alfred/contracts";
import { logger } from "@alfred/logging";
import { runDriftHealthCheck } from "./drift-audit/index";
import { embedMemoryChunk, findPendingEmbedChunks, recordMemoryEmbedFailure } from "./chunks";
import { memoryQueue } from "./queue";
import { enqueueExtractionForUser } from "./run";

/**
 * The `memory-cron` worker and its boot-time schedules (ADR-0019, ADR-0025 #3): daily
 * extraction, a 5-minute embed sweep, and the daily drift health check (#219).
 */
export const memoryWorker = memoryQueue.consume({
  label: "memory",
  concurrency: 1,
  handlers: {
    "memory.extract.daily": async (_data, job) => {
      const users = await db().select({ id: userTable.id }).from(userTable);
      const scheduledFor = scheduledFireTime(job).toISOString();
      let enqueued = 0;

      for (const u of users) {
        await enqueueExtractionForUser(u.id, {
          trigger: { kind: "cron", scheduledFor },
        });
        enqueued++;
      }

      logger.info(`[memory:worker] memory.extract.daily fan-out users=${enqueued}`);

      return { enqueued };
    },

    "memory.extract.run": async (data, job) => {
      const result = await enqueueExtractionForUser(data.userId, {
        requestId: `memory-job:${job.id ?? job.timestamp}`,
      });

      logger.info(`[memory:worker] memory.extract.run user=${data.userId} runId=${result.runId}`);

      return result;
    },

    "memory.embed_sweep": async () => embedSweep(),

    "memory.drift_health_check": async () => driftHealthCheck(),
  },
  schedules: [
    {
      kind: "memory.extract.daily",
      repeat: { every: 24 * 60 * 60 * 1000 },
      opts: {
        attempts: 3,
        backoff: { type: "exponential", delay: 60_000 },
        removeOnComplete: { count: 7, age: 30 * 24 * 60 * 60 },
        removeOnFail: { count: 30, age: 90 * 24 * 60 * 60 },
      },
    },
    {
      kind: "memory.embed_sweep",
      repeat: { every: 5 * 60 * 1000 },
      opts: {
        attempts: 2,
        backoff: { type: "exponential", delay: 30_000 },
        removeOnComplete: { count: 20, age: 24 * 60 * 60 },
        removeOnFail: { count: 50, age: 7 * 24 * 60 * 60 },
      },
    },
    // Rides this queue: it reads the same tables as the daily extraction.
    {
      kind: "memory.drift_health_check",
      repeat: { every: 24 * 60 * 60 * 1000 },
      opts: {
        attempts: 3,
        backoff: { type: "exponential", delay: 60_000 },
        removeOnComplete: { count: 7, age: 30 * 24 * 60 * 60 },
        removeOnFail: { count: 30, age: 90 * 24 * 60 * 60 },
      },
    },
  ],
});

async function embedSweep() {
  const candidates = await findPendingEmbedChunks(50);
  let succeeded = 0;
  let failed = 0;

  for (const c of candidates) {
    let vec: number[];

    try {
      vec = await embed(c.content, {
        inputType: "document",
        userId: c.userId,
        idempotencyKey: `memory-embed:${c.id}`,
      });
    } catch (err) {
      failed++;
      // Only the Voyage call counts toward the poison-pill guard. Log a failed
      // bookkeeping write loudly, or the backlog re-embeds forever.
      await recordMemoryEmbedFailure(c.id, c.userId, err).catch((bookkeepingErr) => {
        logger.error(
          { err: bookkeepingErr },
          `[memory:worker] memory.embed_sweep FAILED to record embed failure for ${c.id}`,
        );
      });
      logger.warn({ err }, `[memory:worker] memory.embed_sweep embed failed for ${c.id}`);
      continue;
    }

    try {
      await embedMemoryChunk(c.id, c.userId, vec);
      succeeded++;
    } catch (err) {
      failed++;
      // A DB write failure is not an embed failure: do not count it, or a good
      // chunk dead-letters. The next sweep retries.
      logger.warn({ err }, `[memory:worker] memory.embed_sweep write failed for ${c.id}`);
    }
  }

  logger.info(
    `[memory:worker] memory.embed_sweep candidates=${candidates.length} succeeded=${succeeded} failed=${failed}`,
  );

  return { candidates: candidates.length, succeeded, failed };
}

/** Rethrows after the loop if any check failed, so BullMQ retries the alert. */
async function driftHealthCheck() {
  const users = await db().select({ id: userTable.id }).from(userTable);
  let checked = 0;
  let breached = 0;
  const failures: string[] = [];

  for (const u of users) {
    try {
      const result = await runDriftHealthCheck(u.id);
      checked++;
      breached += result.breached.length;
    } catch (err) {
      const message = toMessage(err);
      failures.push(`${u.id}: ${message}`);
      logger.error({ err }, `[memory:worker] drift_health_check failed user=${u.id}`);
    }
  }

  logger.info(`[memory:worker] memory.drift_health_check users=${checked} breached=${breached}`);

  if (failures.length > 0) {
    throw new Error(`[memory:worker] drift_health_check failures: ${failures.join("; ")}`);
  }

  return { checked, breached };
}
