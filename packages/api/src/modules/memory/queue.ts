import { user as userTable } from "@alfred/db/schemas";
import { Queue, Worker, type Job } from "bullmq";
import { db } from "@alfred/db";
import { createRedisConnection } from "../../queue/connection";
import { createRun, enqueueRun } from "../agent/index";

/**
 * Memory-cron queue. Holds repeatable jobs that fan out into per-user
 * `memory-extraction` agent runs. Distinct from the ingestion queue
 * (which is provider-bounded) and the agent queue (which is run-id
 * keyed) so the daily trigger stays in its own lane.
 */
export const MEMORY_QUEUE_NAME = "memory-cron";

export type MemoryJobData =
  /** Repeatable trigger; handler enumerates active users and creates a run for each. */
  | { kind: "memory.extract.daily" }
  /** Direct trigger (manual ad-hoc invocation) — single-user fan-out. */
  | { kind: "memory.extract.run"; userId: string };

let _queue: Queue<MemoryJobData> | undefined;
let _worker: Worker<MemoryJobData> | undefined;

export function getMemoryQueue(): Queue<MemoryJobData> {
  if (_queue) return _queue;
  _queue = new Queue<MemoryJobData>(MEMORY_QUEUE_NAME, {
    connection: createRedisConnection(),
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
    connection: createRedisConnection(),
    // The job is cheap (queries + enqueue); single-threaded is plenty.
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
      // Single-user today, but the shape carries us forward.
      const users = await db().select({ id: userTable.id }).from(userTable);
      let enqueued = 0;
      for (const u of users) {
        await enqueueExtractionForUser(u.id);
        enqueued++;
      }
      console.log(`[memory:worker] memory.extract.daily fan-out users=${enqueued}`);
      return { enqueued };
    }
    case "memory.extract.run": {
      const result = await enqueueExtractionForUser(data.userId);
      console.log(
        `[memory:worker] memory.extract.run user=${data.userId} runId=${result.runId}`,
      );
      return result;
    }
    default: {
      const _exhaustive: never = data;
      throw new Error(`unknown memory job kind: ${JSON.stringify(_exhaustive)}`);
    }
  }
}

/** Public helper — also used by ad-hoc HTTP routes / smoke scripts. */
export async function enqueueExtractionForUser(
  userId: string,
  opts?: {
    sinceDays?: number;
    maxDocs?: number;
    /** Manual mode for tests — bypasses the LLM call. */
    mode?: "auto" | "manual";
    manualProposals?: Record<
      string,
      Array<{ key: string; value: unknown; confidence: number; rationale: string }>
    >;
  },
): Promise<{ runId: string }> {
  const { runId } = await createRun({
    userId,
    workflowSlug: "memory-extraction",
    brief: "daily fact extraction over recently-ingested documents",
    input: {
      mode: opts?.mode ?? "auto",
      manualProposals: opts?.manualProposals,
      sinceDays: opts?.sinceDays,
      maxDocs: opts?.maxDocs,
    },
  });
  await enqueueRun(runId);
  return { runId };
}
