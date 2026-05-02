import { Queue, Worker, type Job } from "bullmq";
import {
  findCredentialsNeedingPoll,
  findExpiringGmailWatches,
  ingestRecentGmail,
  installGmailWatch,
  pollGmailHistory,
} from "@alfred/integrations/google";
import { findUnembeddedDocumentIds, embedDocument } from "@alfred/ingestion";
import { serverEnv } from "@alfred/env/server";
import { createRedisConnection } from "../../queue/connection";
import { enqueueRun } from "../agent/queue";
import { createRun } from "../agent/service";
import { TRIAGE_WORKFLOW_SLUG } from "../triage/workflow-input";

/**
 * Ingestion queue. Each provider gets its own job kind so a stuck
 * Slack-shaped job doesn't block Gmail throughput. Job kinds:
 *  - gmail.ingest_recent  (m7a) — bulk recent-window ingest
 *  - gmail.poll_history   (m7c) — incremental history.list delta sync
 *  - gmail.watch_renew    (m7c) — replace watch channels nearing expiry
 *  - gmail.poll_sweep     (m7c) — repeatable: enqueue polls for stale cursors
 *  - gmail.embed_sweep    (m7c) — repeatable: retry embed for chunkless docs
 */
export const INGESTION_QUEUE_NAME = "ingestion-runs";

export type IngestionJobData =
  | { kind: "gmail.ingest_recent"; credentialId: string; query?: string; maxMessages?: number }
  | { kind: "gmail.poll_history"; credentialId: string; reason?: "webhook" | "poll-fallback" }
  | { kind: "gmail.watch_renew" }
  | { kind: "gmail.poll_sweep" }
  | { kind: "gmail.embed_sweep" };

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
        `[ingestion:worker] gmail.ingest_recent credential=${data.credentialId} ` +
          `fetched=${result.fetched} inserted=${result.inserted} skipped=${result.skipped} errors=${result.errors}`,
      );
      return result;
    }
    case "gmail.poll_history": {
      const result = await pollGmailHistory({ credentialId: data.credentialId });
      console.log(
        `[ingestion:worker] gmail.poll_history credential=${data.credentialId} ` +
          `reason=${data.reason ?? "?"} pages=${result.pagesFetched} inserted=${result.inserted} ` +
          `errors=${result.errors} fullResync=${result.fullResync}`,
      );
      // Fan triage runs over freshly-inserted docs (ADR-0025 #1). One run
      // per doc — each gets its own Gmail label. We deliberately do NOT
      // triage the bulk re-ingest path: fullResync pulls in 30+ days of
      // backlog, and labels on month-old emails add noise without value.
      if (!result.fullResync && result.insertedDocumentIds.length) {
        // Webhook polls are real-time triggers; sweep-driven polls are an
        // ingestion fallback when pubsub is silent — record them distinctly
        // so the audit log tells the two paths apart.
        const triageReason = data.reason === "poll-fallback" ? "ingest" : "webhook";
        await enqueueTriageRuns(result.userId, result.insertedDocumentIds, triageReason);
      }
      return result;
    }
    case "gmail.watch_renew": {
      // Renew anything expiring within 24h. ADR-0024 caps watch life at
      // ~7d, so a daily renewal cycle is well within margin.
      const env = serverEnv();
      const topic = env.GOOGLE_PUBSUB_TOPIC;
      if (!topic) {
        console.warn(
          "[ingestion:worker] gmail.watch_renew: GOOGLE_PUBSUB_TOPIC not set — skipping",
        );
        return { renewed: 0, skipped: 0 };
      }
      const horizon = new Date(Date.now() + 24 * 60 * 60 * 1000);
      const candidates = await findExpiringGmailWatches(horizon);
      let renewed = 0;
      let failed = 0;
      for (const c of candidates) {
        try {
          await installGmailWatch({ credentialId: c.id, topicName: topic });
          renewed++;
        } catch (err) {
          failed++;
          console.warn(
            `[ingestion:worker] watch renew failed for ${c.id}:`,
            err instanceof Error ? err.message : String(err),
          );
        }
      }
      console.log(
        `[ingestion:worker] gmail.watch_renew checked=${candidates.length} renewed=${renewed} failed=${failed}`,
      );
      return { renewed, failed, checked: candidates.length };
    }
    case "gmail.poll_sweep": {
      // Fallback: enqueue per-credential polls for any cursor older than
      // 5min. Webhook-driven polls keep healthy mailboxes out of this.
      const cutoff = new Date(Date.now() - 5 * 60 * 1000);
      const stale = await findCredentialsNeedingPoll(cutoff);
      const queue = getIngestionQueue();
      for (const c of stale) {
        await queue.add(
          "gmail.poll_history",
          { kind: "gmail.poll_history", credentialId: c.credentialId, reason: "poll-fallback" },
          // Dedupe in-flight polls per credential — if a webhook just
          // fired and a poll is already queued for this id, don't pile on.
          { jobId: `gmail.poll_history:${c.credentialId}` },
        );
      }
      console.log(`[ingestion:worker] gmail.poll_sweep enqueued=${stale.length}`);
      return { enqueued: stale.length };
    }
    case "gmail.embed_sweep": {
      // Pick up documents whose embed step failed during ingest. Bounded
      // batch — anything left over comes back next tick.
      const ids = await findUnembeddedDocumentIds({ source: "gmail", limit: 50 });
      let succeeded = 0;
      let failed = 0;
      for (const id of ids) {
        try {
          const r = await embedDocument({ documentId: id });
          if (!r.empty) succeeded++;
        } catch (err) {
          failed++;
          console.warn(
            `[ingestion:worker] gmail.embed_sweep failed for ${id}:`,
            err instanceof Error ? err.message : String(err),
          );
        }
      }
      console.log(
        `[ingestion:worker] gmail.embed_sweep candidates=${ids.length} succeeded=${succeeded} failed=${failed}`,
      );
      return { candidates: ids.length, succeeded, failed };
    }
    default: {
      const _exhaustive: never = data;
      throw new Error(`unknown ingestion job kind: ${JSON.stringify(_exhaustive)}`);
    }
  }
}

/**
 * Spawn one email-triage run per freshly-inserted Gmail document (ADR-0025
 * #1). Failures are logged-and-swallowed: we never want a triage-enqueue
 * problem to fail the ingestion job that just successfully wrote the docs.
 *
 * `reason` is a small audit string surfaced on the run's metadata so we can
 * tell webhook-driven triages apart from manual smoke runs in the logs.
 */
async function enqueueTriageRuns(
  userId: string,
  documentIds: string[],
  reason: "webhook" | "manual" | "ingest" | "reply",
): Promise<void> {
  for (const documentId of documentIds) {
    try {
      const { runId } = await createRun({
        userId,
        workflowSlug: TRIAGE_WORKFLOW_SLUG,
        input: { documentId, reason },
        metadata: { source: "gmail", triggeredBy: reason, documentId },
      });
      await enqueueRun(runId);
    } catch (err) {
      console.warn(
        `[ingestion:worker] failed to enqueue triage for doc=${documentId}:`,
        err instanceof Error ? err.message : String(err),
      );
    }
  }
}
