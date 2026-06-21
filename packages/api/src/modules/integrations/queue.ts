import { Queue, Worker, type Job } from "bullmq";
import { mapConcurrent, runTaskGroup } from "@alfred/contracts";
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
import { emitEvent } from "../workflows/events";
import { reconcileThreadLabel } from "../triage/tags";

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
const REALTIME_EMIT_CONCURRENCY = 10;
const REALTIME_EMBED_CONCURRENCY = 4;

export type IngestionJobData =
  | {
      kind: "gmail.ingest_recent";
      credentialId: string;
      query?: string;
      maxMessages?: number;
      /**
       * Emit triage trigger events for freshly-inserted docs after this job finishes.
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
      /**
       * Install the Gmail `users.watch` channel for a freshly-connected
       * credential so pub/sub realtime (ADR-0037) starts flowing. Enqueued
       * by the OAuth callback — without it a new account has no watch, so
       * mail is only caught by the 5-min `gmail.poll_sweep` fallback.
       * Idempotent: re-installing overwrites `metadata.watch`.
       */
      kind: "gmail.watch_install";
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
  | { kind: "gmail.embed_sweep" }
  | {
      /**
       * Reconcile one thread's Gmail label to its current `email_triage`
       * category after a user override (rfc-triage-tags.md). Enqueued by the
       * Replicache push handler post-commit; runs `reconcileThreadLabel`,
       * which is idempotent under the per-thread advisory lock.
       */
      kind: "triage.relabel";
      userId: string;
      sourceThreadId: string;
    };

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
  // Job-level failures are distinct from worker `error` events: BullMQ catches
  // a throwing processor, marks the job failed, and retries silently. Without
  // this listener a credential going `invalid_grant` produced 100 dead
  // poll_history jobs and zero log lines — Gmail ingestion went dark for 36h
  // with no signal. Log every failed attempt so the next outage is visible.
  _worker.on("failed", (job, err) => {
    console.error(
      `[ingestion:worker] job failed kind=${job?.data?.kind ?? "?"} id=${job?.id ?? "?"} ` +
        `attempt=${job?.attemptsMade ?? "?"}: ${err.message}`,
    );
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
          `fetched=${result.fetched} inserted=${result.inserted} skipped=${result.skipped} ignored=${result.ignored} errors=${result.errors}`,
      );
      if (result.insertedDocumentIds.length) {
        // Triage event emission (optional) and the rail-update publish are
        // independent writes to different tables; fan them out so a
        // large bulk seed doesn't pay the latencies in series. Triage fans
        // over `triageDocumentIds` only — sent mail is ingested + embedded
        // (inline in the ingestor) but never triaged/labeled (ADR-0051 #7).
        await runTaskGroup([
          async () => {
            if (data.triageInsertedDocs) {
              await emitGmailMessageEvents(result.userId, result.triageDocumentIds, "ingest");
            }
          },
          async () => {
            await publishInboxUpdate(result.userId, "ingested", result.insertedDocumentIds.length);
          },
        ]);
      }
      return result;
    }
    case "gmail.poll_recent": {
      // Pub/sub-driven realtime path (ADR-0037). Lists messages from Gmail's
      // search index (`newer_than:5m`), dedupes against `documents.source_id`,
      // and emits triage trigger events on inserts. We don't touch history.list here — that
      // path's index lags pub/sub and was the source of 1–3 min tag-latency
      // tails. Catch-up for anything missed lives on `gmail.poll_history`
      // via the 5-min sweep below.
      const result = await pollGmailRecent({ credentialId: data.credentialId });
      console.log(
        `[ingestion:worker] gmail.poll_recent credential=${data.credentialId} ` +
          `listed=${result.listed} inserted=${result.inserted} skipped=${result.skipped} ` +
          `ignored=${result.ignored} errors=${result.errors} cursor=${result.cursorBefore ?? "?"}->${result.cursorAfter ?? "?"}`,
      );
      if (result.insertedDocumentIds.length) {
        // Triage event emission, embed fan-out, and the rail-update publish
        // are independent — they target different tables / queues and
        // each function swallows its own errors. Fan them out so the
        // realtime tag-latency budget (ADR-0037) isn't compounded by
        // Voyage embed latency or outbox round-trips.
        await runTaskGroup([
          // Triage non-sent inserts only; embed ALL inserts (sent mail is
          // embedded for chat recall but never triaged — ADR-0051 #7).
          async () => {
            await emitGmailMessageEvents(result.userId, result.triageDocumentIds, "webhook");
          },
          async () => {
            await embedRealtimeInserts(result.insertedDocumentIds);
          },
          async () => {
            await publishInboxUpdate(result.userId, "ingested", result.insertedDocumentIds.length);
          },
        ]);
      }
      return result;
    }
    case "gmail.poll_history": {
      const result = await pollGmailHistory({ credentialId: data.credentialId });
      console.log(
        `[ingestion:worker] gmail.poll_history credential=${data.credentialId} ` +
          `reason=${data.reason ?? "?"} pages=${result.pagesFetched} inserted=${result.inserted} ` +
          `skipped=${result.skipped} ignored=${result.ignored} errors=${result.errors} fullResync=${result.fullResync} ` +
          `cursor=${result.cursorBefore ?? "?"}->${result.cursorAfter ?? "?"}`,
      );
      // Catch-up path (ADR-0037): the realtime `gmail.poll_recent` job
      // covers the steady state; anything it misses (bursts > maxMessages,
      // a webhook lost in flight, a >5min outage) shows up here as a
      // `messagesAdded` history entry. We still fan triage so a missed
      // realtime ingestion doesn't go untagged.
      if (!result.fullResync && result.insertedDocumentIds.length) {
        await runTaskGroup([
          async () => {
            await emitGmailMessageEvents(result.userId, result.triageDocumentIds, "ingest");
          },
          async () => {
            await publishInboxUpdate(result.userId, "ingested", result.insertedDocumentIds.length);
          },
        ]);
      }
      return result;
    }
    case "gmail.watch_install": {
      // Net-new watch for a just-connected credential. Distinct from
      // `gmail.watch_renew`, which only refreshes already-installed watches
      // nearing expiry (`findExpiringGmailWatches`) and so never covers a
      // brand-new account. Without this, realtime (ADR-0037) never starts
      // and the account is stuck on the 5-min poll_sweep until the watch
      // happens to be installed some other way.
      const env = serverEnv();
      const topic = env.GOOGLE_PUBSUB_TOPIC;
      if (!topic) {
        console.warn(
          "[ingestion:worker] gmail.watch_install: GOOGLE_PUBSUB_TOPIC not set — skipping",
        );
        return { installed: false, reason: "no-topic" };
      }
      const state = await installGmailWatch({ credentialId: data.credentialId, topicName: topic });
      console.log(
        `[ingestion:worker] gmail.watch_install credential=${data.credentialId} ` +
          `expiresAt=${state.expiresAt}`,
      );
      return { installed: true, expiresAt: state.expiresAt };
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
    case "triage.relabel": {
      // One label-writer for both the classifier and user overrides
      // (rfc-triage-tags.md, Invariant 6).
      const result = await reconcileThreadLabel({
        userId: data.userId,
        sourceThreadId: data.sourceThreadId,
      });
      console.log(
        `[ingestion:worker] triage.relabel thread=${data.sourceThreadId} applied=${result.applied}`,
      );
      return result;
    }
    default: {
      const _exhaustive: never = data;
      throw new Error(`unknown ingestion job kind: ${JSON.stringify(_exhaustive)}`);
    }
  }
}

/**
 * Emit one Gmail message event per freshly-inserted Gmail document. Failures
 * are logged-and-swallowed: we never want trigger dispatch to fail the
 * ingestion job that just successfully wrote the docs.
 *
 * `reason` is a small audit string surfaced on the run's trigger payload so
 * we can tell webhook-driven triages apart from manual smoke runs in the logs.
 *
 * Fan-out runs in parallel — N dispatches still cost N event lookups plus any
 * matching DB INSERTs + Redis ZADDs, but they're issued concurrently so wall-clock time is bounded by
 * the slowest one rather than the sum. The realtime path almost always
 * has N≤3, but a catch-up burst after a long quiet period can have dozens.
 */
async function emitGmailMessageEvents(
  userId: string,
  documentIds: string[],
  reason: "webhook" | "manual" | "ingest" | "reply",
): Promise<void> {
  await mapConcurrent(documentIds, REALTIME_EMIT_CONCURRENCY, async (documentId) => {
    try {
      await emitEvent({
        userId,
        source: "gmail",
        type: "message_received",
        eventId: documentId,
        payload: { documentId, reason },
      });
    } catch (err) {
      console.warn(
        `[ingestion:worker] failed to emit gmail.message_received for doc=${documentId}:`,
        err instanceof Error ? err.message : String(err),
      );
    }
  });
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
 * refresh, not a missed write — the rail's 5-min poll backstops it.
 */
async function publishInboxUpdate(
  userId: string,
  reason: "ingested" | "triaged",
  count: number,
): Promise<void> {
  try {
    // `inboxUpdatedSchema` caps `count` at 10_000; a bulk back-catalog
    // re-ingest can exceed that. The count is telemetry-only (clients
    // don't act on it), so clamp instead of letting validation throw
    // and lose the refresh signal entirely.
    const payload = { reason, count: Math.min(count, 10_000) } as const;
    await publishEvent({ userId, kind: "inbox.updated", payload });
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
  await mapConcurrent(documentIds, REALTIME_EMBED_CONCURRENCY, async (documentId) => {
    try {
      await embedDocument({ documentId });
    } catch (err) {
      console.warn(
        `[ingestion:worker] gmail.poll_recent embed failed for doc=${documentId}:`,
        err instanceof Error ? err.message : String(err),
      );
    }
  });
}
