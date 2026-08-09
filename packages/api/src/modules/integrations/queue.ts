import { randomUUID } from "node:crypto";
import { Queue, Worker, type Job } from "bullmq";
import { toMessage } from "@alfred/contracts";
import { findExpiringGmailWatches } from "@alfred/integrations/google";
import {
  findCredentialsNeedingPoll,
  ingestRecentGmail,
  installGmailWatchAndSeedCursor,
  pollGmailHistory,
  pollGmailRecent,
} from "./gmail-ingest";
import { retryPending } from "@alfred/corpus";
import { gmailMailboxWritesEnabled, serverEnv } from "@alfred/env/server";
import { publishDomainEvent, type GmailDocumentsIngestedPayload } from "@alfred/assistant/triggers";
import { createRedisConnection } from "@alfred/db/redis";
import { runGmailTriageRelabel } from "./gmail-triage";
import { refoldGmailKindProjection, scheduleGmailKindRefoldSweep } from "./gmail-user-model";
import {
  claimChatMediaEnrichment,
  cleanupChatMediaPrefix,
  cleanupPendingChatMediaUploads,
  enrichChatMedia,
  recordChatMediaEnqueueFailure,
} from "./chat-media";
import { assertGmailPushOidcConfigured } from "./gmail-push-config";

/**
 * Ingestion queue. Each provider gets its own job kind so a stuck
 * Slack-shaped job doesn't block Gmail throughput. Job kinds:
 *  - gmail.ingest_recent  (m7a) — bulk recent-window ingest
 *  - gmail.poll_recent    (ADR-0037) — pub/sub realtime path; messages.list search index
 *  - gmail.poll_history   (m7c) — history.list catch-up; demoted to poll-fallback only
 *  - gmail.watch_renew    (m7c) — replace watch channels nearing expiry
 *  - gmail.poll_sweep     (m7c) — repeatable: enqueue polls for stale cursors
 *  - gmail.embed_sweep    (m7c) — repeatable: retry embed for chunkless docs
 *  - user_model.gmail_kind_refold — refresh active Gmail kind projection after
 *                    live observation capture.
 */
const INGESTION_QUEUE_NAME = "ingestion-runs";
const USER_MODEL_GMAIL_REFOLD_DEDUP_TTL_MS = 10 * 60 * 1000;
const PENDING_UPLOAD_CLEANUP_DELAY_MS = 24 * 60 * 60 * 1000;

type GmailInsertJobKind = GmailDocumentsIngestedPayload["jobKind"];

interface GmailInsertResult {
  userId: string;
  insertedDocumentIds: string[];
  /** Freshly-inserted docs the ingestor did NOT embed inline — the ingestor owns this fact. */
  unembeddedDocumentIds: readonly string[];
  triageDocumentIds: string[];
  sentDocumentIds: string[];
  touchedThreadIds: string[];
}

export function hasGmailPostInsertSideEffects(args: {
  insertedDocumentIds: readonly string[];
  sentDocumentIds: readonly string[];
  touchedThreadIds: readonly string[];
}): boolean {
  return (
    args.insertedDocumentIds.length > 0 ||
    args.sentDocumentIds.length > 0 ||
    args.touchedThreadIds.length > 0
  );
}

/**
 * Publish the batch fact `gmail.documents_ingested` for one completed insert
 * job. This is the ONLY downstream call the Gmail insert path makes: the
 * connection layer states the raw fact and imports no domain reaction. The
 * independent consumers — corpus embed, user-model capture, inbox rail, triage
 * post-insert — subscribe through composition (`gmail-ingested-consumers.ts`)
 * and each owns its own policy over these document sets.
 *
 * `result.unembeddedDocumentIds` (the docs the corpus consumer must embed) is
 * decided by the ingestor at the point where the inline embed happens or is
 * deferred, so this publisher forwards it uniformly and holds no embed-policy
 * knowledge of its own.
 */
async function publishGmailDocumentsIngested(args: {
  credentialId: string;
  jobKind: GmailInsertJobKind;
  triageInsertedDocs?: boolean | undefined;
  fullResync?: boolean | undefined;
  result: GmailInsertResult;
}): Promise<void> {
  await publishDomainEvent({
    userId: args.result.userId,
    source: "gmail",
    type: "documents_ingested",
    eventId: `gmail.documents_ingested:${args.credentialId}:${randomUUID()}`,
    payload: {
      credentialId: args.credentialId,
      jobKind: args.jobKind,
      ...(args.triageInsertedDocs !== undefined
        ? { triageInsertedDocs: args.triageInsertedDocs }
        : {}),
      ...(args.fullResync !== undefined ? { fullResync: args.fullResync } : {}),
      insertedDocumentIds: args.result.insertedDocumentIds,
      triageDocumentIds: args.result.triageDocumentIds,
      sentDocumentIds: args.result.sentDocumentIds,
      touchedThreadIds: args.result.touchedThreadIds,
      unembeddedDocumentIds: [...args.result.unembeddedDocumentIds],
    },
  });
}

export type IngestionJobData =
  | {
      kind: "media.enrich";
      userId: string;
      attachmentId: string;
      estimatedCostMicrousd: number;
    }
  | {
      kind: "gmail.ingest_recent";
      credentialId: string;
      query?: string | undefined;
      maxMessages?: number | undefined;
      /**
       * Emit triage trigger events for freshly-inserted docs after this job finishes.
       * Default false — bulk re-ingests (30+ days of backlog) skip triage to
       * avoid burning LLM tokens on stale mail. The OAuth callback opts in
       * for the small first-connect seed (~8 messages).
       */
      triageInsertedDocs?: boolean | undefined;
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
       * Re-project the active Gmail kind-only user-model after live observation
       * capture. No active projection means no-op: initial activation remains
       * the committed script's job.
       */
      kind: "user_model.gmail_kind_refold";
      userId: string;
    }
  | {
      /**
       * Scheduled backstop (#218 PR J): fan out `user_model.gmail_kind_refold`
       * to every user with an ACTIVE user-model projection, keeping the Gmail
       * kind projection fresh when live-capture refolds were missed or a
       * backfill added observations out-of-band. Per-user refolds still pass the
       * frozen-logic gate before activating; the fan-out itself never activates.
       */
      kind: "user_model.gmail_kind_refold_sweep";
    }
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
    }
  | {
      /**
       * Reap chat attachment objects from the bucket under a key prefix
       * (ADR-0065). Object storage has no FK cascade, so when a thread (or, in
       * future, an account) is deleted, the rows cascade but the bytes don't —
       * this job drops `chat/{userId}/{threadId}/` (or `chat/{userId}/`) by
       * prefix. Enqueued post-commit by the Replicache push handler. Best-effort
       * and idempotent: a missing prefix is a no-op.
       */
      kind: "media.cleanup";
      userId: string;
      prefix: string;
    }
  | {
      /**
       * Reap uploaded attachment objects that never got a durable
       * `chat_attachments` row. Scheduled when `/attachments/upload` accepts a
       * key; successful `/turn` writes make this a no-op because the exact
       * storage key is now present in Postgres.
       */
      kind: "media.cleanup_pending_upload";
      userId: string;
      keys: string[];
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

/**
 * Enqueue a chat-attachment bucket cleanup for a key prefix (ADR-0065). Called
 * post-commit when a thread (or account) is deleted — the rows cascade, the
 * bytes are reaped here. Deduplicated per prefix so a double-delete coalesces.
 */
export async function enqueueChatStorageCleanup(userId: string, prefix: string): Promise<void> {
  await getIngestionQueue().add(
    "media.cleanup",
    { kind: "media.cleanup", userId, prefix },
    { deduplication: { id: `media.cleanup.${prefix}` } },
  );
}

export async function enqueuePendingUploadCleanup(userId: string, key: string): Promise<void> {
  await getIngestionQueue().add(
    "media.cleanup_pending_upload",
    { kind: "media.cleanup_pending_upload", userId, keys: [key] },
    {
      delay: PENDING_UPLOAD_CLEANUP_DELAY_MS,
      deduplication: { id: `media.cleanup_pending_upload.${key}` },
    },
  );
}

interface ChatEnrichmentQueueDeps {
  claim(attachmentId: string): Promise<"claimed" | "existing">;
  enqueue(args: {
    userId: string;
    attachmentId: string;
    estimatedCostMicrousd: number;
  }): Promise<void>;
  recordEnqueueFailure(attachmentId: string): Promise<void>;
}

/** Internal test seam for the claim -> enqueue -> failure-transition lifecycle. */
export async function enqueueChatAttachmentEnrichmentWith(
  deps: ChatEnrichmentQueueDeps,
  args: { userId: string; attachmentId: string; estimatedCostMicrousd: number },
): Promise<"scheduled" | "existing"> {
  const claim = await deps.claim(args.attachmentId);
  if (claim === "existing") return "existing";
  try {
    await deps.enqueue(args);
    return "scheduled";
  } catch (error) {
    await deps.recordEnqueueFailure(args.attachmentId);
    throw error;
  }
}

export async function enqueueChatAttachmentEnrichment(args: {
  userId: string;
  attachmentId: string;
  estimatedCostMicrousd: number;
}): Promise<"scheduled" | "existing"> {
  return enqueueChatAttachmentEnrichmentWith(
    {
      claim: async (attachmentId) => claimChatMediaEnrichment({ attachmentId }),
      enqueue: async (request) => {
        await getIngestionQueue().add(
          "media.enrich",
          { kind: "media.enrich", ...request },
          { jobId: `media-enrich.${request.attachmentId}` },
        );
      },
      recordEnqueueFailure: async (attachmentId) => {
        await recordChatMediaEnqueueFailure({ attachmentId });
      },
    },
    args,
  );
}

export async function closeIngestionQueue(): Promise<void> {
  if (_queue) {
    await _queue.close();
    _queue = undefined;
  }
}

async function processIngestionJob(job: Job<IngestionJobData>): Promise<unknown> {
  return processIngestionJobData(job.data);
}

async function processIngestionJobData(data: IngestionJobData): Promise<unknown> {
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
      if (hasGmailPostInsertSideEffects(result)) {
        // Publish the batch fact; the composition-registered consumers react.
        // The ingestor set `result.unembeddedDocumentIds`; this publisher forwards it.
        await publishGmailDocumentsIngested({
          credentialId: data.credentialId,
          jobKind: data.kind,
          triageInsertedDocs: data.triageInsertedDocs,
          result,
        });
      }
      return result;
    }
    case "gmail.poll_recent": {
      // Pub/sub-driven realtime path (ADR-0037). Lists messages from Gmail's
      // search index (`newer_than:5m`), persists/dedupes by `documents.source_id`,
      // and publishes the batch fact on inserts. We don't touch history.list here — that
      // path's index lags pub/sub and was the source of 1–3 min tag-latency
      // tails. Catch-up for anything missed lives on `gmail.poll_history`
      // via the 5-min sweep below.
      const result = await pollGmailRecent({ credentialId: data.credentialId });
      console.log(
        `[ingestion:worker] gmail.poll_recent credential=${data.credentialId} ` +
          `listed=${result.listed} inserted=${result.inserted} skipped=${result.skipped} ` +
          `ignored=${result.ignored} errors=${result.errors} cursor=${result.cursorBefore ?? "?"}->${result.cursorAfter ?? "?"}`,
      );
      if (hasGmailPostInsertSideEffects(result)) {
        await publishGmailDocumentsIngested({
          credentialId: data.credentialId,
          jobKind: data.kind,
          result,
        });
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
      // Catch-up path (ADR-0037): the realtime `gmail.poll_recent` job covers
      // the steady state; anything it misses shows up here. The batch fact
      // carries `fullResync` so the triage consumer skips back-catalog triage
      // while still running bounded thread repairs.
      if (hasGmailPostInsertSideEffects(result)) {
        await publishGmailDocumentsIngested({
          credentialId: data.credentialId,
          jobKind: data.kind,
          fullResync: result.fullResync,
          result,
        });
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
      // #278: non-prod must not register a watch on the shared real mailbox.
      if (!gmailMailboxWritesEnabled()) {
        console.log(
          "[ingestion:worker] gmail.watch_install: skipped reason=writes-disabled (non-prod)",
        );
        return { installed: false, reason: "writes-disabled" };
      }
      const env = serverEnv();
      const topic = env.GOOGLE_PUBSUB_TOPIC;
      if (!topic) {
        console.warn(
          "[ingestion:worker] gmail.watch_install: GOOGLE_PUBSUB_TOPIC not set — skipping",
        );
        return { installed: false, reason: "no-topic" };
      }
      assertGmailPushOidcConfigured();
      const state = await installGmailWatchAndSeedCursor({
        credentialId: data.credentialId,
        topicName: topic,
      });
      if (!state) return { installed: false, reason: "writes-disabled" };
      console.log(
        `[ingestion:worker] gmail.watch_install credential=${data.credentialId} ` +
          `expiresAt=${state.expiresAt}`,
      );
      return { installed: true, expiresAt: state.expiresAt };
    }
    case "gmail.watch_renew": {
      // Renew anything expiring within 24h. ADR-0024 caps watch life at
      // ~7d, so a daily renewal cycle is well within margin.
      // #278: non-prod must not touch the shared real mailbox's watch.
      if (!gmailMailboxWritesEnabled()) {
        console.log(
          "[ingestion:worker] gmail.watch_renew: skipped reason=writes-disabled (non-prod)",
        );
        return { renewed: 0, skipped: 0 };
      }
      const env = serverEnv();
      const topic = env.GOOGLE_PUBSUB_TOPIC;
      if (!topic) {
        console.warn(
          "[ingestion:worker] gmail.watch_renew: GOOGLE_PUBSUB_TOPIC not set — skipping",
        );
        return { renewed: 0, skipped: 0 };
      }
      assertGmailPushOidcConfigured();
      const horizon = new Date(Date.now() + 24 * 60 * 60 * 1000);
      const candidates = await findExpiringGmailWatches(horizon);
      let renewed = 0;
      let failed = 0;
      for (const c of candidates) {
        try {
          await installGmailWatchAndSeedCursor({ credentialId: c.id, topicName: topic });
          renewed++;
        } catch (err) {
          failed++;
          console.warn(`[ingestion:worker] watch renew failed for ${c.id}:`, toMessage(err));
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
      // batch — anything left over comes back next tick. The sweep loop is
      // owned by @alfred/corpus (`retryPending`); this case only schedules it
      // and reports the summary count.
      const r = await retryPending({ source: "gmail", limit: 50 });
      console.log(
        `[ingestion:worker] gmail.embed_sweep candidates=${r.candidates} succeeded=${r.succeeded} failed=${r.failed}`,
      );
      return r;
    }
    case "user_model.gmail_kind_refold": {
      return runGmailKindRefoldJob(data.userId);
    }
    case "user_model.gmail_kind_refold_sweep": {
      return scheduleGmailKindRefoldSweep({});
    }
    case "triage.relabel": {
      // One label-writer for both the classifier and user overrides
      // (rfc-triage-tags.md, Invariant 6).
      const result = await runGmailTriageRelabel({
        userId: data.userId,
        sourceThreadId: data.sourceThreadId,
      });
      if (result.applied) {
        console.log(
          `[ingestion:worker] triage.relabel thread=${data.sourceThreadId} applied=true label=${result.appliedLabelId}`,
        );
      } else if (result.reason === "writes-disabled") {
        // #278: expected in non-prod — the mailbox-write gate is off, so the DB
        // row is canonical and Gmail is intentionally untouched. Info, not error.
        console.log(
          `[ingestion:worker] triage.relabel thread=${data.sourceThreadId} skipped reason=writes-disabled`,
        );
      } else {
        // A non-applied relabel must NOT be silent — `applied_label_id` stays
        // unset, so the thread looks untagged in Gmail. Surface the reason
        // (#277: `target-unresolvable` is a dead message id with no live fallback).
        console.error(
          `[ingestion:worker] triage.relabel thread=${data.sourceThreadId} NOT applied reason=${result.reason}`,
        );
      }
      return result;
    }
    case "media.cleanup": {
      return cleanupChatMediaPrefix({
        userId: data.userId,
        prefix: data.prefix,
      });
    }
    case "media.enrich": {
      return enrichChatMedia({
        userId: data.userId,
        attachmentId: data.attachmentId,
        estimatedCostMicrousd: data.estimatedCostMicrousd,
      });
    }
    case "media.cleanup_pending_upload": {
      return cleanupPendingChatMediaUploads({
        userId: data.userId,
        keys: data.keys,
      });
    }
    default: {
      const _exhaustive: never = data;
      throw new Error(`unknown ingestion job kind: ${JSON.stringify(_exhaustive)}`);
    }
  }
}

/** Run one refold job through the registered user-model handler. */
export async function runGmailKindRefoldJob(userId: string) {
  return refoldGmailKindProjection({ userId });
}

export async function enqueueGmailKindRefold(userId: string): Promise<void> {
  await getIngestionQueue().add(
    "user_model.gmail_kind_refold",
    { kind: "user_model.gmail_kind_refold", userId },
    {
      deduplication: {
        id: `user_model.gmail_kind_refold.${userId}`,
        ttl: USER_MODEL_GMAIL_REFOLD_DEDUP_TTL_MS,
      },
      attempts: 2,
      backoff: { type: "exponential", delay: 60_000 },
      removeOnComplete: { count: 20, age: 24 * 60 * 60 },
      removeOnFail: { count: 50, age: 7 * 24 * 60 * 60 },
    },
  );
}

function prepareTriageRelabelJob(
  userId: string,
  sourceThreadId: string,
): {
  jobName: string;
  jobData: { kind: "triage.relabel"; userId: string; sourceThreadId: string };
  dedupId: string;
} {
  return {
    jobName: "triage.relabel",
    jobData: { kind: "triage.relabel", userId, sourceThreadId },
    dedupId: `triage.relabel.${userId}.${sourceThreadId}`,
  };
}

export async function enqueueTriageRelabel(userId: string, sourceThreadId: string): Promise<void> {
  const job = prepareTriageRelabelJob(userId, sourceThreadId);
  const queue = getIngestionQueue();
  await queue.add(job.jobName, job.jobData, {
    deduplication: {
      id: job.dedupId,
      keepLastIfActive: true,
    },
  });
}
