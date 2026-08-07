import { Queue, Worker, type Job } from "bullmq";
import { mapConcurrent, runTaskGroup, toMessage } from "@alfred/contracts";
import { findExpiringGmailWatches } from "@alfred/integrations/google";
import {
  findCredentialsNeedingPoll,
  ingestRecentGmail,
  installGmailWatchAndSeedCursor,
  pollGmailHistory,
  pollGmailRecent,
} from "./gmail-ingest";
import { indexDocument, retryPending } from "@alfred/corpus";
import { gmailMailboxWritesEnabled, serverEnv } from "@alfred/env/server";
import { db } from "@alfred/db";
import { documents, emailTriage } from "@alfred/db/schemas";
import { and, eq, inArray } from "drizzle-orm";
import { publishEvent } from "../../events/publish";
import {
  NoTriggerConsumersRegisteredError,
  publishDomainEvent,
  type GmailMessageEventReason,
} from "../triggers";
import { createRedisConnection } from "../../queue/connection";
import {
  runGmailPostInsertTriage,
  runGmailTriageRelabel,
  type GmailPostInsertTriageResult,
} from "./gmail-triage";
import {
  captureGmailObservations,
  NoGmailUserModelHandlerRegisteredError,
  refoldGmailKindProjection,
  scheduleGmailKindRefoldSweep,
} from "./gmail-user-model";
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
const REALTIME_EMIT_CONCURRENCY = 10;
const REALTIME_EMBED_CONCURRENCY = 4;
export const FULL_RESYNC_REPLY_REEVAL_THREAD_LIMIT = 25;
const REPLY_REEVAL_QUERY_CHUNK_SIZE = 1000;
const USER_MODEL_GMAIL_REFOLD_DEDUP_TTL_MS = 10 * 60 * 1000;
const PENDING_UPLOAD_CLEANUP_DELAY_MS = 24 * 60 * 60 * 1000;

type GmailInsertJobKind = "gmail.ingest_recent" | "gmail.poll_recent" | "gmail.poll_history";
interface ReplyReevalRequest {
  threadId: string;
  eventId: string;
  sentAuthoredAt: Date | null;
}

type ReplyReevalRequestTarget = GmailPostInsertTriageResult["replyReevalTargets"][number];
type ReplyReevalTarget = ReplyReevalRequestTarget & { eventId: string };

export function pairReplyReevalTargets(
  requests: readonly Pick<ReplyReevalRequest, "threadId" | "eventId">[],
  targets: readonly ReplyReevalRequestTarget[],
): ReplyReevalTarget[] {
  const eventIdByThread = new Map(requests.map((request) => [request.threadId, request.eventId]));
  return targets
    .map((target): ReplyReevalTarget | null => {
      const eventId = eventIdByThread.get(target.threadId);
      return eventId ? { ...target, eventId } : null;
    })
    .filter((target): target is ReplyReevalTarget => target !== null);
}

export interface GmailPostInsertSideEffectPlan {
  triageReason: Extract<GmailMessageEventReason, "webhook" | "ingest"> | null;
  triageDocumentIds: string[];
  reconcileThreadIds: string[];
  replyReevalSentDocumentIds: string[];
  replyReevalThreadLimit: number | null;
  skippedReplyReevalSentDocs: number;
  protectedDocumentIds: string[];
}

export function planGmailPostInsertSideEffects(args: {
  jobKind: GmailInsertJobKind;
  triageInsertedDocs?: boolean | undefined;
  fullResync?: boolean;
  triageDocumentIds: readonly string[];
  sentDocumentIds: readonly string[];
  touchedThreadIds: readonly string[];
}): GmailPostInsertSideEffectPlan {
  const triageReason =
    args.jobKind === "gmail.poll_recent"
      ? "webhook"
      : args.jobKind === "gmail.poll_history" && !args.fullResync
        ? "ingest"
        : args.jobKind === "gmail.ingest_recent" && args.triageInsertedDocs
          ? "ingest"
          : null;

  const allowReplyReeval =
    args.jobKind === "gmail.poll_recent" ||
    (args.jobKind === "gmail.poll_history" && !args.fullResync) ||
    (args.jobKind === "gmail.ingest_recent" && args.triageInsertedDocs === true);

  const allowFullResyncReplyReeval = args.jobKind === "gmail.poll_history" && args.fullResync;
  const replyReevalSentDocumentIds =
    allowReplyReeval || allowFullResyncReplyReeval ? [...args.sentDocumentIds] : [];
  const protectedDocumentIds = Array.from(
    new Set([...args.triageDocumentIds, ...args.sentDocumentIds]),
  );

  return {
    triageReason,
    triageDocumentIds: triageReason ? [...args.triageDocumentIds] : [],
    reconcileThreadIds: [...args.touchedThreadIds],
    replyReevalSentDocumentIds,
    replyReevalThreadLimit: allowFullResyncReplyReeval
      ? FULL_RESYNC_REPLY_REEVAL_THREAD_LIMIT
      : null,
    skippedReplyReevalSentDocs: args.sentDocumentIds.length - replyReevalSentDocumentIds.length,
    protectedDocumentIds,
  };
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
 * Fan out the independent post-insert side effects shared by every Gmail
 * insert job (`ingest_recent`, `poll_recent`, `poll_history`): triage event
 * emission, bounded thread repairs, user-model observation capture, the
 * rail-update publish — and, on the realtime path only, embedding inserts.
 * Each targets a different table/queue and swallows its own errors, so they
 * run concurrently (ADR-0037 tag-latency budget) rather than in series.
 */
async function runGmailPostInsertSideEffects(args: {
  credentialId: string;
  plan: GmailPostInsertSideEffectPlan;
  result: { userId: string; insertedDocumentIds: string[] };
  /** Realtime path (`poll_recent`) also embeds inserts for chat recall. */
  embedInserts?: boolean;
}): Promise<void> {
  const { credentialId, plan, result, embedInserts = false } = args;
  const insertedIds = result.insertedDocumentIds;

  await runTaskGroup([
    async () => {
      if (plan.triageReason) {
        await emitGmailMessageEvents(result.userId, plan.triageDocumentIds, plan.triageReason);
      }
    },
    async () => {
      await runGmailRepairSideEffects(credentialId, result.userId, plan);
    },
    async () => {
      if (insertedIds.length) {
        await runGmailObservationCapture(result.userId, insertedIds);
      }
    },
    ...(embedInserts
      ? [
          async () => {
            if (insertedIds.length) {
              await embedRealtimeInserts(insertedIds);
            }
          },
        ]
      : []),
    async () => {
      if (insertedIds.length) {
        await publishInboxUpdate(result.userId, "ingested", insertedIds.length);
      }
    },
  ]);
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
        // Triage event emission (optional) and the rail-update publish are
        // independent writes to different tables; fan them out so a
        // large bulk seed doesn't pay the latencies in series. Triage fans
        // over `triageDocumentIds` only — sent mail is ingested + embedded
        // (inline in the ingestor) but never triaged/labeled (ADR-0051 #7).
        const plan = planGmailPostInsertSideEffects({
          jobKind: data.kind,
          triageInsertedDocs: data.triageInsertedDocs,
          triageDocumentIds: result.triageDocumentIds,
          sentDocumentIds: result.sentDocumentIds,
          touchedThreadIds: result.touchedThreadIds,
        });
        await runGmailPostInsertSideEffects({ credentialId: data.credentialId, plan, result });
      }
      return result;
    }
    case "gmail.poll_recent": {
      // Pub/sub-driven realtime path (ADR-0037). Lists messages from Gmail's
      // search index (`newer_than:5m`), persists/dedupes by `documents.source_id`,
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
      if (hasGmailPostInsertSideEffects(result)) {
        // Triage event emission, embed fan-out, and the rail-update publish
        // are independent — they target different tables / queues and
        // each function swallows its own errors. Fan them out so the
        // realtime tag-latency budget (ADR-0037) isn't compounded by
        // Voyage embed latency or outbox round-trips.
        // Triage non-sent inserts only; embed ALL inserts (sent mail is
        // embedded for chat recall but never triaged — ADR-0051 #7).
        const plan = planGmailPostInsertSideEffects({
          jobKind: data.kind,
          triageDocumentIds: result.triageDocumentIds,
          sentDocumentIds: result.sentDocumentIds,
          touchedThreadIds: result.touchedThreadIds,
        });
        await runGmailPostInsertSideEffects({
          credentialId: data.credentialId,
          plan,
          result,
          embedInserts: true,
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
      // Catch-up path (ADR-0037): the realtime `gmail.poll_recent` job
      // covers the steady state; anything it misses (bursts > maxMessages,
      // a webhook lost in flight, a >5min outage) shows up here as a
      // `messagesAdded` history entry. We still fan triage so a missed
      // realtime ingestion doesn't go untagged. Full-resync fallbacks skip
      // ordinary triage fan-out to avoid back-catalog LLM burn, but they still
      // run bounded thread repairs so the resync can heal sent-reply and dead-id
      // drift instead of preserving it for the next webhook.
      if (hasGmailPostInsertSideEffects(result)) {
        const plan = planGmailPostInsertSideEffects({
          jobKind: data.kind,
          fullResync: result.fullResync,
          triageDocumentIds: result.triageDocumentIds,
          sentDocumentIds: result.sentDocumentIds,
          touchedThreadIds: result.touchedThreadIds,
        });
        await runGmailPostInsertSideEffects({ credentialId: data.credentialId, plan, result });
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

/** Run the user-model side effect while ignoring its best-effort result. */
export async function runGmailObservationCapture(
  userId: string,
  documentIds: readonly string[],
): Promise<void> {
  try {
    await captureGmailObservations({ userId, documentIds });
  } catch (err) {
    if (err instanceof NoGmailUserModelHandlerRegisteredError) throw err;
    console.warn(
      `[ingestion:worker] user-model gmail observation capture failed user=${userId}:`,
      toMessage(err),
    );
  }
}

/** Run one refold job through the registered user-model handler. */
export async function runGmailKindRefoldJob(userId: string) {
  return refoldGmailKindProjection({ userId });
}

/**
 * Emit one Gmail message event per freshly-inserted Gmail document. Event-level
 * failures are logged-and-swallowed so trigger dispatch does not fail an
 * ingestion job that successfully wrote the docs. A missing consumer is a
 * runtime-composition failure instead: it rejects the job so retries and
 * monitoring expose the broken boot path. Strict schema drift remains an
 * event-level failure and emits a warning instead of retrying the completed
 * ingestion write.
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
  reason: GmailMessageEventReason,
): Promise<void> {
  let accountByDocumentId: Map<string, string>;
  try {
    accountByDocumentId = await gmailAccountRefsForDocuments(userId, documentIds);
  } catch (err) {
    console.warn(
      `[ingestion:worker] failed to resolve Gmail event accounts user=${userId}:`,
      toMessage(err),
    );
    return;
  }
  await mapConcurrent(documentIds, REALTIME_EMIT_CONCURRENCY, async (documentId) => {
    try {
      const accountRef = accountByDocumentId.get(documentId);
      await publishDomainEvent({
        userId,
        source: "gmail",
        type: "message_received",
        eventId: documentId,
        ...(accountRef ? { accountRef } : {}),
        payload: { documentId, reason },
      });
    } catch (err) {
      if (err instanceof NoTriggerConsumersRegisteredError) throw err;
      console.warn(
        `[ingestion:worker] failed to emit gmail.message_received for doc=${documentId}:`,
        toMessage(err),
      );
    }
  });
}

async function runGmailRepairSideEffects(
  credentialId: string,
  userId: string,
  plan: GmailPostInsertSideEffectPlan,
): Promise<void> {
  const allReplyReevalRequests = await resolveReplyReevalRequests(
    userId,
    plan.replyReevalSentDocumentIds,
  );
  const replyReevalRequests =
    plan.replyReevalThreadLimit == null
      ? allReplyReevalRequests
      : allReplyReevalRequests.slice(0, plan.replyReevalThreadLimit);
  const { replyReevalTargets } = await runGmailPostInsertTriage({
    credentialId,
    userId,
    reconcileThreadIds: plan.reconcileThreadIds,
    protectedDocumentIds: plan.protectedDocumentIds,
    replyReevalThreadIds: replyReevalRequests.map((request) => request.threadId),
  });
  await reEvaluateRepliedThreads(
    userId,
    pairReplyReevalTargets(replyReevalRequests, replyReevalTargets),
  );
  if (plan.skippedReplyReevalSentDocs > 0) {
    console.warn(
      `[ingestion:worker] reply re-eval skipped sentDocs=${plan.skippedReplyReevalSentDocs} ` +
        `credential=${credentialId}`,
    );
  }
  const skippedReplyReevalThreads = allReplyReevalRequests.length - replyReevalRequests.length;
  if (skippedReplyReevalThreads > 0) {
    console.warn(
      `[ingestion:worker] reply re-eval skipped threads=${skippedReplyReevalThreads} ` +
        `credential=${credentialId}`,
    );
  }
}

/**
 * Re-evaluate a thread's triage tag when the user sends an outbound reply
 * (issue #282). Sent mail is ingested + embedded but deliberately never
 * triaged/labeled and never a sender prior (ADR-0051 #7) — so the kept
 * "re-evaluate on reply" contract only ever fired on INBOUND replies, freezing
 * the tag until the counterparty sent again.
 *
 * We preserve both ADR-0051 #7 guardrails by NOT triaging the sent doc: instead
 * we re-key the received-only classify on the thread's newest INBOUND doc and
 * pass `force` so the already-tagged skip guard re-classifies. `getThreadState`
 * folds the outbound reply in (`lastUserReplyAt` / `recentMessages`), and the
 * workflow skips the sender-prior bump for `reason: "reply"`. A reply means it
 * matters — we re-eval on every outbound reply regardless of current tag.
 *
 * Best-effort: failures are logged, never bubbled into the ingest result.
 */
async function resolveReplyReevalRequests(
  userId: string,
  sentDocumentIds: string[],
): Promise<ReplyReevalRequest[]> {
  if (!sentDocumentIds.length) return [];
  try {
    const sentDocs: Array<{
      id: string;
      threadId: string | null;
      authoredAt: Date | null;
    }> = [];
    for (const documentIdChunk of chunkArray(sentDocumentIds, REPLY_REEVAL_QUERY_CHUNK_SIZE)) {
      sentDocs.push(
        ...(await db()
          .select({
            id: documents.id,
            threadId: documents.sourceThreadId,
            authoredAt: documents.authoredAt,
          })
          .from(documents)
          .where(
            and(
              eq(documents.userId, userId),
              eq(documents.source, "gmail"),
              inArray(documents.id, documentIdChunk),
            ),
          )),
      );
    }
    const byThread = new Map<string, ReplyReevalRequest>();
    for (const doc of sentDocs) {
      if (!doc.threadId) continue;
      const existing = byThread.get(doc.threadId);
      const docIsNewer =
        !existing ||
        compareNullableDatesDesc(doc.authoredAt, existing.sentAuthoredAt) < 0 ||
        (compareNullableDatesDesc(doc.authoredAt, existing.sentAuthoredAt) === 0 &&
          doc.id.localeCompare(existing.eventId) > 0);
      if (docIsNewer) {
        byThread.set(doc.threadId, {
          threadId: doc.threadId,
          eventId: doc.id,
          sentAuthoredAt: doc.authoredAt,
        });
      }
    }
    const threadIds = Array.from(byThread.keys());
    if (!threadIds.length) return [];

    // Only threads we already triage. A brand-new outbound-first thread has no
    // triage row to refresh and no inbound doc to key the received-only
    // classify on.
    const triagedThreadIds = new Set<string>();
    for (const threadIdChunk of chunkArray(threadIds, REPLY_REEVAL_QUERY_CHUNK_SIZE)) {
      const triaged = await db()
        .select({ threadId: emailTriage.sourceThreadId })
        .from(emailTriage)
        .where(
          and(eq(emailTriage.userId, userId), inArray(emailTriage.sourceThreadId, threadIdChunk)),
        );
      for (const row of triaged) {
        triagedThreadIds.add(row.threadId);
      }
    }
    return Array.from(byThread.values())
      .filter((request) => triagedThreadIds.has(request.threadId))
      .sort(
        (a, b) =>
          compareNullableDatesDesc(a.sentAuthoredAt, b.sentAuthoredAt) ||
          b.eventId.localeCompare(a.eventId),
      );
  } catch (err) {
    console.warn(
      `[ingestion:worker] resolveReplyReevalRequests failed user=${userId}:`,
      toMessage(err),
    );
    return [];
  }
}

async function reEvaluateRepliedThreads(
  userId: string,
  targets: ReplyReevalTarget[],
): Promise<void> {
  if (!targets.length) return;
  try {
    const accountByDocumentId = await gmailAccountRefsForDocuments(
      userId,
      targets.map((target) => target.documentId),
    );
    await mapConcurrent(
      targets,
      REALTIME_EMIT_CONCURRENCY,
      async ({ threadId, documentId, eventId }) => {
        try {
          const accountRef = accountByDocumentId.get(documentId);
          await publishDomainEvent({
            userId,
            source: "gmail",
            type: "message_received",
            eventId,
            ...(accountRef ? { accountRef } : {}),
            payload: { documentId, reason: "reply", force: true },
          });
        } catch (err) {
          if (err instanceof NoTriggerConsumersRegisteredError) throw err;
          console.warn(
            `[ingestion:worker] reply re-eval failed thread=${threadId}:`,
            toMessage(err),
          );
        }
      },
    );
  } catch (err) {
    if (err instanceof NoTriggerConsumersRegisteredError) throw err;
    console.warn(
      `[ingestion:worker] reEvaluateRepliedThreads failed user=${userId}:`,
      toMessage(err),
    );
  }
}

async function gmailAccountRefsForDocuments(
  userId: string,
  documentIds: readonly string[],
): Promise<Map<string, string>> {
  const accountByDocumentId = new Map<string, string>();
  for (const ids of chunkArray(documentIds, REPLY_REEVAL_QUERY_CHUNK_SIZE)) {
    const rows = await db()
      .select({ id: documents.id, accountId: documents.accountId })
      .from(documents)
      .where(
        and(
          eq(documents.userId, userId),
          eq(documents.source, "gmail"),
          inArray(documents.id, ids),
        ),
      );
    for (const row of rows) {
      if (row.accountId) accountByDocumentId.set(row.id, row.accountId);
    }
  }
  return accountByDocumentId;
}

function compareNullableDatesDesc(a: Date | null, b: Date | null): number {
  const timeDiff =
    (b?.getTime() ?? Number.NEGATIVE_INFINITY) - (a?.getTime() ?? Number.NEGATIVE_INFINITY);
  if (timeDiff !== 0) return timeDiff;
  return 0;
}

function chunkArray<T>(values: readonly T[], size: number): T[][] {
  const chunks: T[][] = [];
  for (let i = 0; i < values.length; i += size) {
    chunks.push(values.slice(i, i + size));
  }
  return chunks;
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
    await publishEvent({ untransacted: true, userId, kind: "inbox.updated", payload });
  } catch (err) {
    console.warn(
      `[ingestion:worker] publishInboxUpdate failed user=${userId} reason=${reason}:`,
      toMessage(err),
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
      await indexDocument({ documentId });
    } catch (err) {
      console.warn(
        `[ingestion:worker] gmail.poll_recent embed failed for doc=${documentId}:`,
        toMessage(err),
      );
    }
  });
}
