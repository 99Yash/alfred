import { Queue, Worker, type Job } from "bullmq";
import { ingestRecentGmail } from "@alfred/integrations/google";
import { createRedisConnection } from "../../queue/connection";

/**
 * Ingestion queue. Each provider gets its own job kind so a stuck
 * Slack-shaped job doesn't block Gmail throughput. m7a only ships
 * `gmail.ingest_recent`; m7c will add `gmail.poll_history`.
 */
export const INGESTION_QUEUE_NAME = "ingestion-runs";

export type IngestionJobData =
  | { kind: "gmail.ingest_recent"; credentialId: string; query?: string; maxMessages?: number };

let _queue: Queue<IngestionJobData> | undefined;
let _worker: Worker<IngestionJobData> | undefined;

export function getIngestionQueue(): Queue<IngestionJobData> {
  if (_queue) return _queue;
  _queue = new Queue<IngestionJobData>(INGESTION_QUEUE_NAME, {
    connection: createRedisConnection(),
    defaultJobOptions: {
      // Long-running ingestion can fail mid-page; let BullMQ retry with
      // exponential backoff. The DB unique index makes re-runs safe.
      attempts: 5,
      backoff: { type: "exponential", delay: 5_000 },
      removeOnComplete: { count: 50, age: 24 * 60 * 60 },
      removeOnFail: { count: 100, age: 7 * 24 * 60 * 60 },
    },
  });
  return _queue;
}

export interface StartIngestionWorkerOpts {
  concurrency?: number;
}

export async function startIngestionWorker(opts: StartIngestionWorkerOpts = {}): Promise<void> {
  if (_worker) return;
  _worker = new Worker<IngestionJobData>(INGESTION_QUEUE_NAME, processIngestionJob, {
    connection: createRedisConnection(),
    // Default 2: ingestion is I/O-heavy but per-credential; bumping this
    // mostly helps when a user connects multiple Google accounts.
    concurrency: opts.concurrency ?? 2,
  });
  _worker.on("error", (err) => {
    console.error("[ingestion:worker] error:", err.message);
  });
}

export async function stopIngestionWorker(): Promise<void> {
  if (_worker) {
    await _worker.close();
    _worker = undefined;
  }
}

export async function closeIngestionQueue(): Promise<void> {
  if (_queue) {
    await _queue.close();
    _queue = undefined;
  }
}

async function processIngestionJob(job: Job<IngestionJobData>): Promise<unknown> {
  const data = job.data;
  switch (data.kind) {
    case "gmail.ingest_recent": {
      const result = await ingestRecentGmail({
        credentialId: data.credentialId,
        query: data.query,
        maxMessages: data.maxMessages,
      });
      console.log(
        `[ingestion:worker] gmail credential=${data.credentialId} ` +
          `fetched=${result.fetched} inserted=${result.inserted} skipped=${result.skipped} errors=${result.errors}`,
      );
      return result;
    }
    default: {
      const _exhaustive: never = data;
      throw new Error(`unknown ingestion job kind: ${JSON.stringify(_exhaustive)}`);
    }
  }
}
