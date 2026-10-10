import { randomUUID } from "node:crypto";
import { Queue, Worker, type Job } from "bullmq";
import { INBOUND_EVENT_SOURCES, toMessage } from "@alfred/contracts";
import { findExpiringGmailWatches } from "@alfred/integrations/google";
import {
  findCredentialsNeedingPoll,
  ingestRecentGmail,
  installGmailWatchAndSeedCursor,
  pollGmailHistory,
  pollGmailRecent,
  runGmailMediaIngest,
  type GmailPollHistoryReason,
} from "./gmail-ingest";
import { formatMediaTally } from "./gmail-media";
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
import { assertGmailPushOidcConfigured } from "@alfred/integrations/google";
import { deliverInboundReceipt } from "./inbound-deliver";
import { runDeliveryAlertSweepForAllUsers } from "./delivery-alert-sweep";
import { backfillReceiptDocuments } from "./receipt-corpus-backfill";
import {
  observeDocumentAskCarrier,
  type DocumentAskObserveResult,
  type GmailMessageLocator,
  type ScheduleDocumentAskObserve,
} from "../document-asks";

/**
 * Ingestion queue: Gmail sync, chat media, document-ask re-observes, user-model refolds and inbound
 * receipt delivery.
 * Repeatable schedules live in `repeatable.ts`.
 */
const INGESTION_QUEUE_NAME = "ingestion-runs";

const USER_MODEL_GMAIL_REFOLD_DEDUP_TTL_MS = 10 * 60 * 1000;

const PENDING_UPLOAD_CLEANUP_DELAY_MS = 24 * 60 * 60 * 1000;

type GmailInsertJobKind = GmailDocumentsIngestedPayload["jobKind"];

interface GmailInsertResult {
  userId: string;
  insertedDocumentIds: string[];
  /** Inserts the ingestor did not embed inline. The ingestor decides this. */
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
 * Publish `gmail.documents_ingested` for one insert job. This is the only downstream call the Gmail
 * insert path makes; consumers subscribe in `gmail-ingested-consumers.ts`.
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
       * Emit triage events for the inserts. Default false, so bulk backlogs do not burn LLM tokens.
       * The OAuth callback opts in for the small first-connect seed.
       */
      triageInsertedDocs?: boolean | undefined;
    }
  | {
      kind: "gmail.poll_recent";
      credentialId: string;
      /** Pub/Sub push historyId, for gap detection (#560b). */
      pushHistoryId?: string;
    }
  | {
      /**
       * Install the Gmail watch for a new credential (ADR-0037). `gmail.watch_renew` only renews
       * existing watches, so without this a new account gets only the 5-minute sweep.
       */
      kind: "gmail.watch_install";
      credentialId: string;
    }
  | {
      kind: "gmail.poll_history";
      credentialId: string;
      /**
       * `webhook` is for manual replay or backfill. `poll-fallback` inserts are the stale-push
       * evidence (#998).
       */
      reason?: GmailPollHistoryReason;
    }
  | { kind: "gmail.watch_renew" }
  | { kind: "gmail.poll_sweep" }
  | { kind: "gmail.embed_sweep" }
  | { kind: "ingress.health_sweep" }
  | {
      /** Deferred attachment ingest for one message (ADR-0091 amendment). Idempotent. */
      kind: "gmail.media_ingest";
      credentialId: string;
      messageId: string;
      /** Mail document that carries the `mediaPending` flag. */
      documentId: string;
    }
  | {
      /** Re-observe one sent carrier after a sibling's media barrier closes. */
      kind: "document_ask.observe";
      userId: string;
      carrier: GmailMessageLocator;
      /**
       * Epoch ms the observe is scheduled for. The worker observes at `max(now, atMs)`, so a worker
       * whose clock is behind still sees the barrier closed and does not re-add its own dedup id.
       */
      atMs: number;
    }
  | {
      /** Re-project the active Gmail kind user-model. No active projection means no-op. */
      kind: "user_model.gmail_kind_refold";
      userId: string;
    }
  | {
      /**
       * Backstop: refold every user with an active projection, in case a live refold was missed.
       * The fan-out never activates; each refold still passes the frozen-logic gate.
       */
      kind: "user_model.gmail_kind_refold_sweep";
    }
  | {
      /** Sync one thread's Gmail label to its `email_triage` category after a user override. */
      kind: "triage.relabel";
      userId: string;
      sourceThreadId: string;
    }
  | {
      /** Delete chat attachment bytes under a key prefix (ADR-0065). Storage has no FK cascade. */
      kind: "media.cleanup";
      userId: string;
      prefix: string;
    }
  | {
      /**
       * Delete uploads that never got a `chat_attachments` row. A no-op once `/turn` saved the key.
       */
      kind: "media.cleanup_pending_upload";
      userId: string;
      keys: string[];
    }
  | {
      /** Publish one `event_receipts` row to the trigger bus (ADR-0097). */
      kind: "ingress.deliver";
      receiptId: string;
    };

let _queue: Queue<IngestionJobData> | undefined;

let _worker: Worker<IngestionJobData> | undefined;

export function getIngestionQueue(): Queue<IngestionJobData> {
  if (_queue) return _queue;
  _queue = new Queue<IngestionJobData>(INGESTION_QUEUE_NAME, {
    connection: createRedisConnection("queue"),
    defaultJobOptions: {
      // The DB unique index makes retries safe.
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
    connection: createRedisConnection("queue"),
    concurrency: opts.concurrency ?? 2,
  });
  _worker.on("error", (err) => {
    console.error("[ingestion:worker] error:", err.message);
  });
  // BullMQ retries a failed job silently. Without this log, an `invalid_grant` once left Gmail
  // ingestion dark for 36h with no signal.
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

/** Delete chat attachment bytes for a deleted thread or account (ADR-0065). Dedups per prefix. */
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

/** Test seam for the claim, enqueue, failure lifecycle. */
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

/**
 * Enqueue delivery of one stored receipt (ADR-0097). `jobId` is the receipt id, so a redelivery is
 * a no-op while the job exists. BullMQ refuses a duplicate `jobId` in every state, failed too, so
 * `removeOnFail: true` lets a redelivery revive a receipt whose last attempt failed.
 */
export async function enqueueInboundDelivery(receiptId: string): Promise<void> {
  await getIngestionQueue().add(
    "ingress.deliver",
    { kind: "ingress.deliver", receiptId },
    { jobId: `ingress.deliver.${receiptId}`, removeOnFail: true },
  );
}

const GMAIL_MEDIA_INGEST_DEDUP_TTL_MS = 60_000;

/** Schedule attachment ingest for one message. The dedup TTL collapses concurrent schedules. */
export async function enqueueGmailMediaIngest(args: {
  credentialId: string;
  messageId: string;
  documentId: string;
}): Promise<void> {
  await getIngestionQueue().add(
    "gmail.media_ingest",
    { kind: "gmail.media_ingest", ...args },
    {
      deduplication: {
        // Gmail message ids are mailbox-scoped; keep linked-account schedules distinct.
        id: `gmail.media_ingest.${args.credentialId}.${args.messageId}`,
        ttl: GMAIL_MEDIA_INGEST_DEDUP_TTL_MS,
      },
    },
  );
}

/**
 * Schedule one carrier re-observe at `at`. The dedup id includes `at`: a simple-mode key is held
 * until its job completes, so an id without it would drop the next re-observe a job schedules.
 */
export const enqueueDocumentAskObserve: ScheduleDocumentAskObserve = async ({
  userId,
  carrier,
  at,
}) => {
  await getIngestionQueue().add(
    "document_ask.observe",
    { kind: "document_ask.observe", userId, carrier, atMs: at.getTime() },
    {
      delay: Math.max(0, at.getTime() - Date.now()),
      deduplication: {
        id: `document_ask.observe.${carrier.accountId}.${carrier.messageId}.${at.getTime()}`,
      },
    },
  );
};

function formatObserveResult(result: DocumentAskObserveResult): string {
  switch (result.kind) {
    case "deferred":
      return `deferred retryAt=${result.retryAt.toISOString()}`;
    case "noop":
      return `noop reason=${result.reason}`;
    case "resolved":
      return `resolved resolutions=${result.resolutions.length}`;
    default: {
      const _exhaustive: never = result;
      throw new Error(`unknown document-ask observe result: ${JSON.stringify(_exhaustive)}`);
    }
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
        scheduleMediaIngest: enqueueGmailMediaIngest,
      });

      console.log(
        `[ingestion:worker] gmail.ingest_recent credential=${data.credentialId} ` +
          `fetched=${result.fetched} inserted=${result.inserted} skipped=${result.skipped} ignored=${result.ignored} errors=${result.errors}`,
      );

      if (hasGmailPostInsertSideEffects(result)) {
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
      // Realtime path on a Pub/Sub push (ADR-0037). `history.list` lags the push, so it is only the
      // catch-up path.
      const result = await pollGmailRecent({
        credentialId: data.credentialId,
        pushHistoryId: data.pushHistoryId,
        deps: { scheduleMediaIngest: enqueueGmailMediaIngest },
      });

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
      const result = await pollGmailHistory({
        credentialId: data.credentialId,
        reason: data.reason,
        scheduleMediaIngest: enqueueGmailMediaIngest,
      });

      console.log(
        `[ingestion:worker] gmail.poll_history credential=${data.credentialId} ` +
          `reason=${data.reason ?? "?"} pages=${result.pagesFetched} inserted=${result.inserted} ` +
          `skipped=${result.skipped} ignored=${result.ignored} errors=${result.errors} fullResync=${result.fullResync} ` +
          `cursor=${result.cursorBefore ?? "?"}->${result.cursorAfter ?? "?"}`,
      );

      // `fullResync` makes the triage consumer skip back-catalog triage.
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
      // Gmail watches expire after about 7 days, so daily renewal of the next 24h is enough. #278:
      // non-prod must not touch the shared real mailbox's watch.
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
      // Sweep every cursor: even a recent push can miss mail outside its search window.
      const stale = await findCredentialsNeedingPoll();
      const queue = getIngestionQueue();

      for (const c of stale) {
        await queue.add(
          "gmail.poll_history",
          { kind: "gmail.poll_history", credentialId: c.credentialId, reason: "poll-fallback" },
          // One waiting poll plus at most one follow-up while a poll runs.
          {
            deduplication: {
              id: `gmail.poll_history.${c.credentialId}`,
              keepLastIfActive: true,
            },
          },
        );
      }

      console.log(`[ingestion:worker] gmail.poll_sweep enqueued=${stale.length}`);

      return { enqueued: stale.length };
    }

    case "gmail.embed_sweep": {
      // Retry failed embeds in separate bounded batches, so a busy source cannot starve another.
      // Inbound batches also project receipts stored before #989.
      const [mail, media, ...inbound] = await Promise.all([
        retryPending({ source: "gmail", limit: 50 }),
        retryPending({ source: "gmail_attachment", limit: 50 }),
        ...INBOUND_EVENT_SOURCES.map(async (source) => {
          await backfillReceiptDocuments(source);

          return retryPending({ source, limit: 50 });
        }),
      ]);

      const candidates =
        mail.candidates + media.candidates + inbound.reduce((sum, r) => sum + r.candidates, 0);

      const succeeded =
        mail.succeeded + media.succeeded + inbound.reduce((sum, r) => sum + r.succeeded, 0);

      const failed = mail.failed + media.failed + inbound.reduce((sum, r) => sum + r.failed, 0);
      console.log(
        `[ingestion:worker] gmail.embed_sweep candidates=${candidates} succeeded=${succeeded} failed=${failed} ` +
          `(mail ${mail.candidates}/${mail.succeeded}/${mail.failed}, attachment ${media.candidates}/${media.succeeded}/${media.failed})`,
      );

      return {
        candidates,
        succeeded,
        failed,
        mail,
        media,
        inbound,
      };
    }

    case "gmail.media_ingest": {
      const result = await runGmailMediaIngest({
        credentialId: data.credentialId,
        messageId: data.messageId,
        documentId: data.documentId,
        scheduleObserve: enqueueDocumentAskObserve,
      });

      console.log(
        `[ingestion:worker] gmail.media_ingest message=${data.messageId} ${formatMediaTally(result)}`,
      );

      return result;
    }

    case "document_ask.observe": {
      const result = await observeDocumentAskCarrier(
        {
          userId: data.userId,
          carrier: data.carrier,
          observedAt: new Date(Math.max(Date.now(), data.atMs)),
        },
        enqueueDocumentAskObserve,
      );

      console.log(
        `[ingestion:worker] document_ask.observe message=${data.carrier.messageId} ${formatObserveResult(result)}`,
      );

      return result;
    }

    case "user_model.gmail_kind_refold": {
      return runGmailKindRefoldJob(data.userId);
    }

    case "user_model.gmail_kind_refold_sweep": {
      return scheduleGmailKindRefoldSweep({});
    }

    case "triage.relabel": {
      // One label writer for classifier and user overrides.
      const result = await runGmailTriageRelabel({
        userId: data.userId,
        sourceThreadId: data.sourceThreadId,
      });

      if (result.applied) {
        console.log(
          `[ingestion:worker] triage.relabel thread=${data.sourceThreadId} applied=true label=${result.appliedLabelId}`,
        );
      } else if (result.reason === "writes-disabled") {
        // #278: expected in non-prod. The DB row is canonical.
        console.log(
          `[ingestion:worker] triage.relabel thread=${data.sourceThreadId} skipped reason=writes-disabled`,
        );
      } else {
        // Never silent: the thread looks untagged in Gmail (#277).
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

    case "ingress.deliver": {
      return deliverInboundReceipt(data.receiptId);
    }

    case "ingress.health_sweep": {
      return runDeliveryAlertSweepForAllUsers();
    }

    default: {
      const _exhaustive: never = data;
      throw new Error(`unknown ingestion job kind: ${JSON.stringify(_exhaustive)}`);
    }
  }
}

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

interface TriageRelabelJob {
  jobName: string;
  jobData: { kind: "triage.relabel"; userId: string; sourceThreadId: string };
  dedupId: string;
}

function prepareTriageRelabelJob(userId: string, sourceThreadId: string): TriageRelabelJob {
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
