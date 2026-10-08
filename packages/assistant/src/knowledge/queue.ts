import { user as userTable, type AgentRunTrigger } from "@alfred/db/schemas";
import { embed } from "@alfred/ai/embeddings";
import { Queue, Worker, type Job } from "bullmq";
import { randomUUID } from "node:crypto";
import { db } from "@alfred/db";
import { createRedisConnection } from "@alfred/db/redis";
import { startRun } from "@alfred/assistant/execution";
import { runDriftHealthCheck } from "./drift-audit/index";
import { embedMemoryChunk, findPendingEmbedChunks, recordMemoryEmbedFailure } from "./chunks";
import { toMessage } from "@alfred/contracts";

/** Memory-cron queue: repeatable jobs that fan out into per-user runs. */
const MEMORY_QUEUE_NAME = "memory-cron";

export type MemoryJobData =
  /** Repeatable: one run per active user. */
  | { kind: "memory.extract.daily" }
  /** Ad-hoc run for one user. */
  | { kind: "memory.extract.run"; userId: string }
  /** Repeatable: embed chunks written without one. */
  | { kind: "memory.embed_sweep" }
  /** Repeatable drift health check (#219). Shares this queue to save Redis connections. */
  | { kind: "memory.drift_health_check" };

let _queue: Queue<MemoryJobData> | undefined;

let _worker: Worker<MemoryJobData> | undefined;

export function getMemoryQueue(): Queue<MemoryJobData> {
  if (_queue) return _queue;
  _queue = new Queue<MemoryJobData>(MEMORY_QUEUE_NAME, {
    connection: createRedisConnection("queue"),
    defaultJobOptions: {
      attempts: 3,
      backoff: { type: "exponential", delay: 30_000 },
      removeOnComplete: { count: 20, age: 7 * 24 * 60 * 60 },
      removeOnFail: { count: 50, age: 30 * 24 * 60 * 60 },
    },
  });

  return _queue;
}

export interface StartMemoryWorkerOpts {
  concurrency?: number;
}

export async function startMemoryWorker(opts: StartMemoryWorkerOpts = {}): Promise<void> {
  if (_worker) return;
  _worker = new Worker<MemoryJobData>(MEMORY_QUEUE_NAME, processMemoryJob, {
    connection: createRedisConnection("queue"),
    concurrency: opts.concurrency ?? 1,
  });
  _worker.on("error", (err) => {
    console.error("[memory:worker] error:", err.message);
  });
}

export async function stopMemoryWorker(): Promise<void> {
  if (_worker) {
    await _worker.close();
    _worker = undefined;
  }
}

export async function closeMemoryQueue(): Promise<void> {
  if (_queue) {
    await _queue.close();
    _queue = undefined;
  }
}

async function processMemoryJob(job: Job<MemoryJobData>): Promise<unknown> {
  const data = job.data;

  switch (data.kind) {
    case "memory.extract.daily": {
      const users = await db().select({ id: userTable.id }).from(userTable);
      const scheduledFor = new Date(job.timestamp).toISOString();
      let enqueued = 0;

      for (const u of users) {
        await enqueueExtractionForUser(u.id, {
          trigger: { kind: "cron", scheduledFor },
        });
        enqueued++;
      }

      console.log(`[memory:worker] memory.extract.daily fan-out users=${enqueued}`);

      return { enqueued };
    }

    case "memory.extract.run": {
      const result = await enqueueExtractionForUser(data.userId, {
        requestId: `memory-job:${job.id ?? job.timestamp}`,
      });

      console.log(`[memory:worker] memory.extract.run user=${data.userId} runId=${result.runId}`);

      return result;
    }

    case "memory.embed_sweep": {
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
            console.error(
              `[memory:worker] memory.embed_sweep FAILED to record embed failure for ${c.id}:`,
              toMessage(bookkeepingErr),
            );
          });
          console.warn(
            `[memory:worker] memory.embed_sweep embed failed for ${c.id}:`,
            toMessage(err),
          );
          continue;
        }

        try {
          await embedMemoryChunk(c.id, c.userId, vec);
          succeeded++;
        } catch (err) {
          failed++;
          // A DB write failure is not an embed failure: do not count it, or a good
          // chunk dead-letters. The next sweep retries.
          console.warn(
            `[memory:worker] memory.embed_sweep write failed for ${c.id}:`,
            toMessage(err),
          );
        }
      }

      console.log(
        `[memory:worker] memory.embed_sweep candidates=${candidates.length} succeeded=${succeeded} failed=${failed}`,
      );

      return { candidates: candidates.length, succeeded, failed };
    }

    case "memory.drift_health_check": {
      // Rethrow after the loop if any check failed, so BullMQ retries the alert.
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
          console.error(`[memory:worker] drift_health_check failed user=${u.id}:`, message);
        }
      }

      console.log(
        `[memory:worker] memory.drift_health_check users=${checked} breached=${breached}`,
      );

      if (failures.length > 0) {
        throw new Error(`[memory:worker] drift_health_check failures: ${failures.join("; ")}`);
      }

      return { checked, breached };
    }

    default: {
      const _exhaustive: never = data;
      throw new Error(`unknown memory job kind: ${JSON.stringify(_exhaustive)}`);
    }
  }
}

/** Also used by ad-hoc routes and smoke scripts. */
export async function enqueueExtractionForUser(
  userId: string,
  opts?: {
    sinceDays?: number;
    maxDocs?: number;
    /** Skips the LLM call. */
    mode?: "auto" | "manual";
    manualProposals?: Record<
      string,
      Array<{ key: string; value: unknown; confidence: number; rationale: string }>
    >;
    /** Defaults to manual. */
    trigger?: AgentRunTrigger;
    /** Stable id from a retryable caller. */
    requestId?: string;
  },
): Promise<{ runId: string }> {
  const trigger = opts?.trigger ?? { kind: "manual" as const };

  const occurrence =
    trigger.kind === "cron"
      ? {
          trigger,
          workflowRevisionId: null,
          occurrence: {
            kind: "cron" as const,
            workflowId: "memory-extraction",
            revisionId: null,
            scheduledFor: trigger.scheduledFor,
          },
        }
      : trigger.kind === "event"
        ? {
            trigger,
            workflowRevisionId: null,
            occurrence: {
              kind: "event" as const,
              workflowId: "memory-extraction",
              provider: trigger.source ?? "unknown",
              eventId: trigger.eventId,
            },
          }
        : trigger.kind === "manual"
          ? {
              trigger,
              occurrence: {
                kind: "manual" as const,
                requestId: opts?.requestId ?? randomUUID(),
              },
            }
          : { trigger };

  const { runId } = await startRun({
    userId,
    workflowSlug: "memory-extraction",
    brief: "daily fact extraction over recently-ingested documents",
    input: {
      mode: opts?.mode ?? "auto",
      manualProposals: opts?.manualProposals,
      sinceDays: opts?.sinceDays,
      maxDocs: opts?.maxDocs,
    },
    ...occurrence,
  });

  return { runId };
}
