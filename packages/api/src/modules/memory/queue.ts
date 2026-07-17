import { user as userTable, type AgentRunTrigger } from "@alfred/db/schemas";
import { embed } from "@alfred/ai/embeddings";
import { Queue, Worker, type Job } from "bullmq";
import { db } from "@alfred/db";
import { createRedisConnection } from "../../queue/connection";
import { createRun, enqueueRun } from "../agent/index";
import { runDriftHealthCheck } from "../drift-audit/index";
import { embedMemoryChunk, findPendingEmbedChunks, recordMemoryEmbedFailure } from "./chunks";
import { toMessage } from "@alfred/contracts";

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
  | { kind: "memory.extract.run"; userId: string }
  /** Repeatable: backfill embeddings for memory_chunks written without one. */
  | { kind: "memory.embed_sweep" }
  /**
   * Repeatable: drift / invariant health check (#219 PR-B). Folded into this
   * queue rather than a 9th worker — it sweeps the same `documents`/`email_triage`
   * data the daily extraction already reads, so a dedicated worker would buy ~$0
   * of Railway compute while costing persistent Redis connections.
   */
  | { kind: "memory.drift_health_check" };

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
      const scheduledFor = new Date().toISOString();
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
      const result = await enqueueExtractionForUser(data.userId);
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
          // Only the embed (Voyage) call counts toward the poison-pill guard —
          // record it so a genuinely un-embeddable chunk dead-letters instead of
          // being re-embedded every sweep forever (best-effort bookkeeping).
          // Log a bookkeeping-write failure DISTINCTLY: a persistently-failing
          // guard write (dropped column, bad migration order) would otherwise
          // no-op silently while the backlog re-embeds forever.
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
          // A DB write failure is a *persistence* error, not an embed failure —
          // the (billed) embedding already succeeded — so it must NOT record a
          // failure (which would increment `embedAttempts` and eventually
          // dead-letter a perfectly embeddable chunk). Leave the row a candidate
          // (embedding still NULL) so the next sweep retries. Mirrors the
          // documents path in `@alfred/ingestion`.
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
      // Single-user today; the per-user fan-out carries us forward. Sweep every
      // user, but rethrow after the loop if any check failed so BullMQ retries a
      // dropped health_alert push.
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
    /** Trigger context — defaults to manual when called ad-hoc. */
    trigger?: AgentRunTrigger;
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
    trigger: opts?.trigger ?? { kind: "manual" },
  });
  await enqueueRun(runId);
  return { runId };
}
