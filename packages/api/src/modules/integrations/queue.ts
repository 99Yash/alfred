import { Queue, Worker, type Job } from "bullmq";
import {
  findCredentialsNeedingPoll,
  findExpiringGmailWatches,
  ingestRecentGmail,
  installGmailWatch,
  pollGmailHistory,
  pollGmailRecent,
} from "@alfred/integrations/google";
import { findUnembeddedDocumentIds, embedDocument } from "@alfred/ingestion";
import { serverEnv } from "@alfred/env/server";
import { publishEvent } from "../../events/publish";
import { createRedisConnection } from "../../queue/connection";
import { enqueueRun } from "../agent/queue";
import { createRun } from "../agent/service";
import { TRIAGE_WORKFLOW_SLUG } from "../triage/workflow-input";

/**
 * Ingestion queue. Each provider gets its own job kind so a stuck
 * Slack-shaped job doesn't block Gmail throughput. Job kinds:
 *  - gmail.ingest_recent  (m7a) — bulk recent-window ingest
 *  - gmail.poll_recent    (ADR-0037) — pub/sub realtime path; messages.list search index
 *  - gmail.poll_history   (m7c) — history.list catch-up; demoted to poll-fallback only
 *  - gmail.watch_renew    (m7c) — replace watch channels nearing expiry
 *  - gmail.poll_sweep     (m7c) — repeatable: enqueue polls for stale cursors
 *  - gmail.embed_sweep    (m7c) — repeatable: retry embed for chunkless docs
 */
export const INGESTION_QUEUE_NAME = "ingestion-runs";

export type IngestionJobData =
  | {
      kind: "gmail.ingest_recent";
      credentialId: string;
      query?: string;
      maxMessages?: number;
      /**
       * Fan triage runs over the freshly-inserted docs after this job finishes.
       * Default false — bulk re-ingests (30+ days of backlog) skip triage to
       * avoid burning LLM tokens on stale mail. The OAuth callback opts in
       * for the small first-connect seed (~8 messages).
       */
      triageInsertedDocs?: boolean;
    }
  | {
      kind: "gmail.poll_recent";
      credentialId: string;
    }
  | {
      kind: "gmail.poll_history";
      credentialId: string;
      /**
       * `webhook` is retained for the rare manual replay or backfill case;
       * realtime traffic flows through `gmail.poll_recent` after ADR-0037.
       */
      reason?: "webhook" | "poll-fallback";
    }
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
      if (data.triageInsertedDocs && result.insertedDocumentIds.length) {
        await enqueueTriageRuns(result.userId, result.insertedDocumentIds, "ingest");
      }
      if (result.insertedDocumentIds.length) {
        await publishInboxUpdate(result.userId, "ingested", result.insertedDocumentIds.length);
      }
      return result;
    }
    case "gmail.poll_recent": {
      // Pub/sub-driven realtime path (ADR-0037). Lists messages from Gmail's
      // search index (`newer_than:5m`), dedupes against `documents.source_id`,
      // and fans triage on inserts. We don't touch history.list here — that
      // path's index lags pub/sub and was the source of 1–3 min tag-latency
      // tails. Catch-up for anything missed lives on `gmail.poll_history`
      // via the 5-min sweep below.
      const result = await pollGmailRecent({ credentialId: data.credentialId });
      console.log(
        `[ingestion:worker] gmail.poll_recent credential=${data.credentialId} ` +
          `listed=${result.listed} inserted=${result.inserted} skipped=${result.skipped} ` +
          `errors=${result.errors} cursor=${result.cursorBefore ?? "?"}->${result.cursorAfter ?? "?"}`,
      );
      if (result.insertedDocumentIds.length) {
        // Triage first, embed second — the triage worker picks up the jobs
        // and starts classifying while we're still waiting on Voyage.
        // Triage reads the doc row (not chunks), so an in-flight embed is
        // irrelevant to it. The `gmail.embed_sweep` job backstops any
        // embed that fails here so we don't lose chunks permanently.
        await enqueueTriageRuns(result.userId, result.insertedDocumentIds, "webhook");
        await embedRealtimeInserts(result.insertedDocumentIds);
        await publishInboxUpdate(result.userId, "ingested", result.insertedDocumentIds.length);
      }
      return result;
    }
    case "gmail.poll_history": {
      const result = await pollGmailHistory({ credentialId: data.credentialId });
      console.log(
        `[ingestion:worker] gmail.poll_history credential=${data.credentialId} ` +
          `reason=${data.reason ?? "?"} pages=${result.pagesFetched} inserted=${result.inserted} ` +
          `skipped=${result.skipped} errors=${result.errors} fullResync=${result.fullResync} ` +
          `cursor=${result.cursorBefore ?? "?"}->${result.cursorAfter ?? "?"}`,
      );
      // Catch-up path (ADR-0037): the realtime `gmail.poll_recent` job
      // covers the steady state; anything it misses (bursts > maxMessages,
      // a webhook lost in flight, a >5min outage) shows up here as a
      // `messagesAdded` history entry. We still fan triage so a missed
      // realtime ingestion doesn't go untagged.
      if (!result.fullResync && result.insertedDocumentIds.length) {
        await enqueueTriageRuns(result.userId, result.insertedDocumentIds, "ingest");
        await publishInboxUpdate(result.userId, "ingested", result.insertedDocumentIds.length);
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
          // TTL-bounded dedup: collapses overlap between the 5-min sweep and
          // a near-simultaneous webhook push for the same credential, but
          // releases inside the sweep cadence so the next legitimate sync
          // can land. See gmail-webhook.ts for the matching dedup key.
          { deduplication: { id: `gmail.poll_history.${c.credentialId}`, ttl: 30_000 } },
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
 *
 * Fan-out runs in parallel — N enqueues still cost N DB INSERTs + N Redis
 * ZADDs, but they're issued concurrently so wall-clock time is bounded by
 * the slowest one rather than the sum. The realtime path almost always
 * has N≤3, but a catch-up burst after a long quiet period can have dozens.
 */
async function enqueueTriageRuns(
  userId: string,
  documentIds: string[],
  reason: "webhook" | "manual" | "ingest" | "reply",
): Promise<void> {
  await Promise.all(
    documentIds.map(async (documentId) => {
      try {
        const { runId } = await createRun({
          userId,
          workflowSlug: TRIAGE_WORKFLOW_SLUG,
          input: { documentId, reason },
          metadata: { source: "gmail", documentId },
          // `eventId` is the document id — naturally per-message and lets
          // History filter triages by their source doc.
          trigger: { kind: "event", eventId: documentId, payload: { source: "gmail", reason } },
        });
        await enqueueRun(runId);
      } catch (err) {
        console.warn(
          `[ingestion:worker] failed to enqueue triage for doc=${documentId}:`,
          err instanceof Error ? err.message : String(err),
        );
      }
    }),
  );
}

/**
 * Best-effort `inbox.updated` notification — fires the SSE bus so the
 * chat right-rail can invalidate its `["me","inbox"]` query without
 * polling. We coalesce per-job (one event per N inserts) rather than
 * per-doc so a bursty back-catalog catch-up doesn't generate hundreds
 * of frames. The matching `reason: 'triaged'` half lives in the
 * email-triage workflow.
 *
 * Failures are swallowed-and-logged: a missed SSE frame is a missed
 * refresh, not a missed write — the 60s rail poll backstops it.
 */
async function publishInboxUpdate(
  userId: string,
  reason: "ingested" | "triaged",
  count: number,
): Promise<void> {
  try {
    await publishEvent({ userId, kind: "inbox.updated", payload: { reason, count } });
  } catch (err) {
    console.warn(
      `[ingestion:worker] publishInboxUpdate failed user=${userId} reason=${reason}:`,
      err instanceof Error ? err.message : String(err),
    );
  }
}

/**
 * Embed freshly-inserted realtime docs in parallel. Best-effort: failures
 * are logged and left for `gmail.embed_sweep` to retry. Kept off the
 * triage-enqueue critical path so Voyage latency doesn't compound into
 * the user-visible tag-latency budget (ADR-0037).
 */
async function embedRealtimeInserts(documentIds: string[]): Promise<void> {
  await Promise.all(
    documentIds.map(async (documentId) => {
      try {
        await embedDocument({ documentId });
      } catch (err) {
        console.warn(
          `[ingestion:worker] gmail.poll_recent embed failed for doc=${documentId}:`,
          err instanceof Error ? err.message : String(err),
        );
      }
    }),
  );
}
