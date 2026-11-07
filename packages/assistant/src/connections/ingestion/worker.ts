import { randomUUID } from "node:crypto";
import { INBOUND_EVENT_SOURCES } from "@alfred/contracts";
import { retryPending } from "@alfred/corpus";
import { gmailMailboxWritesEnabled, serverEnv } from "@alfred/env/server";
import {
  assertGmailPushOidcConfigured,
  findExpiringGmailWatches,
} from "@alfred/integrations/google";
import { logger } from "@alfred/logging";
import type { JobInput } from "@alfred/assistant/queue-jobs";
import { publishDomainEvent, type GmailDocumentsIngestedPayload } from "@alfred/assistant/triggers";
import {
  cleanupChatMediaPrefix,
  cleanupPendingChatMediaUploads,
  enrichChatMedia,
} from "./chat-media";
import { runDeliveryAlertSweepForAllUsers } from "./delivery-alert-sweep";
import { GMAIL_POLL_SWEEP_INTERVAL_MS } from "./gmail-delivery-policy";
import {
  findCredentialsNeedingPoll,
  ingestRecentGmail,
  installGmailWatchAndSeedCursor,
  pollGmailHistory,
  pollGmailRecent,
  runGmailMediaIngest,
} from "./gmail-ingest";
import { formatMediaTally } from "./gmail-media";
import { runGmailTriageRelabel } from "./gmail-triage";
import { refoldGmailKindProjection, scheduleGmailKindRefoldSweep } from "./gmail-user-model";
import { deliverInboundReceipt } from "./inbound-deliver";
import { ingestionQueue } from "./queue";
import { backfillReceiptDocuments } from "./receipt-corpus-backfill";

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

/** Schedule attachment ingest for one message. The `gmail.media_ingest` kind owns the dedup. */
async function enqueueGmailMediaIngest(
  args: JobInput<typeof ingestionQueue, "gmail.media_ingest">,
): Promise<void> {
  await ingestionQueue.add("gmail.media_ingest", args);
}

export async function runGmailKindRefoldJob(userId: string) {
  return refoldGmailKindProjection({ userId });
}

/**
 * The `ingestion-runs` worker and its schedules. Each schedule is idempotent, because
 * `upsertJobScheduler` keys by the kind.
 * - `gmail.poll_sweep`: backstop for missed Pub/Sub pushes and missing watches.
 * - `gmail.watch_renew` every 6h: watches expire after about 7 days; 6h leaves room for a failed
 *   run.
 * - `gmail.embed_sweep`: index chunkless docs and project older receipts with no document.
 * - `ingress.health_sweep` every 6h: a broken source sends nothing, so only a schedule notices
 *   (ADR-0100).
 * - `user_model.gmail_kind_refold_sweep` daily: backstop for missed live refolds.
 */
export const ingestionWorker = ingestionQueue.consume({
  label: "ingestion",
  concurrency: 2,
  handlers: {
    "gmail.ingest_recent": async (data) => {
      const result = await ingestRecentGmail({
        credentialId: data.credentialId,
        query: data.query,
        maxMessages: data.maxMessages,
        scheduleMediaIngest: enqueueGmailMediaIngest,
      });

      logger.info(
        `[ingestion:worker] gmail.ingest_recent credential=${data.credentialId} ` +
          `fetched=${result.fetched} inserted=${result.inserted} skipped=${result.skipped} ignored=${result.ignored} errors=${result.errors}`,
      );

      if (hasGmailPostInsertSideEffects(result)) {
        await publishGmailDocumentsIngested({
          credentialId: data.credentialId,
          jobKind: "gmail.ingest_recent",
          triageInsertedDocs: data.triageInsertedDocs,
          result,
        });
      }

      return result;
    },

    "gmail.poll_recent": async (data) => {
      // Realtime path on a Pub/Sub push (ADR-0037). `history.list` lags the push, so it is only the
      // catch-up path.
      const result = await pollGmailRecent({
        credentialId: data.credentialId,
        pushHistoryId: data.pushHistoryId,
        deps: { scheduleMediaIngest: enqueueGmailMediaIngest },
      });

      logger.info(
        `[ingestion:worker] gmail.poll_recent credential=${data.credentialId} ` +
          `listed=${result.listed} inserted=${result.inserted} skipped=${result.skipped} ` +
          `ignored=${result.ignored} errors=${result.errors} cursor=${result.cursorBefore ?? "?"}->${result.cursorAfter ?? "?"} ` +
          `uncoveredPush=${result.uncoveredPushHistoryId ?? "-"} followUp=${data.followUp ?? false}`,
      );

      // One follow-up after the burst dedup window: the index can file a message seconds after
      // the poll read, and the silenced retriggers of its burst carry no poll of their own. The
      // follow-up never spawns one, so a change no recent poll covers falls back to the sweep.
      if (!data.followUp && result.uncoveredPushHistoryId) {
        await ingestionQueue.add("gmail.poll_recent", {
          credentialId: data.credentialId,
          followUp: true,
        });
      }

      if (hasGmailPostInsertSideEffects(result)) {
        await publishGmailDocumentsIngested({
          credentialId: data.credentialId,
          jobKind: "gmail.poll_recent",
          result,
        });
      }

      return result;
    },

    "gmail.poll_history": async (data) => {
      const result = await pollGmailHistory({
        credentialId: data.credentialId,
        reason: data.reason,
        scheduleMediaIngest: enqueueGmailMediaIngest,
      });

      logger.info(
        `[ingestion:worker] gmail.poll_history credential=${data.credentialId} ` +
          `reason=${data.reason ?? "?"} pages=${result.pagesFetched} inserted=${result.inserted} ` +
          `skipped=${result.skipped} ignored=${result.ignored} errors=${result.errors} fullResync=${result.fullResync} ` +
          `cursor=${result.cursorBefore ?? "?"}->${result.cursorAfter ?? "?"}`,
      );

      // `fullResync` makes the triage consumer skip back-catalog triage.
      if (hasGmailPostInsertSideEffects(result)) {
        await publishGmailDocumentsIngested({
          credentialId: data.credentialId,
          jobKind: "gmail.poll_history",
          fullResync: result.fullResync,
          result,
        });
      }

      return result;
    },

    "gmail.watch_install": async (data) => {
      // #278: non-prod must not register a watch on the shared real mailbox.
      if (!gmailMailboxWritesEnabled()) {
        logger.info(
          "[ingestion:worker] gmail.watch_install: skipped reason=writes-disabled (non-prod)",
        );

        return { installed: false, reason: "writes-disabled" };
      }

      const env = serverEnv();
      const topic = env.GOOGLE_PUBSUB_TOPIC;

      if (!topic) {
        logger.warn(
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
      logger.info(
        `[ingestion:worker] gmail.watch_install credential=${data.credentialId} ` +
          `expiresAt=${state.expiresAt}`,
      );

      return { installed: true, expiresAt: state.expiresAt };
    },

    "gmail.watch_renew": async () => {
      // Gmail watches expire after about 7 days, so daily renewal of the next 24h is enough. #278:
      // non-prod must not touch the shared real mailbox's watch.
      if (!gmailMailboxWritesEnabled()) {
        logger.info(
          "[ingestion:worker] gmail.watch_renew: skipped reason=writes-disabled (non-prod)",
        );

        return { renewed: 0, skipped: 0 };
      }

      const env = serverEnv();
      const topic = env.GOOGLE_PUBSUB_TOPIC;

      if (!topic) {
        logger.warn("[ingestion:worker] gmail.watch_renew: GOOGLE_PUBSUB_TOPIC not set — skipping");

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
          logger.warn({ err }, `[ingestion:worker] watch renew failed for ${c.id}`);
        }
      }

      logger.info(
        `[ingestion:worker] gmail.watch_renew checked=${candidates.length} renewed=${renewed} failed=${failed}`,
      );

      return { renewed, failed, checked: candidates.length };
    },

    "gmail.poll_sweep": async () => {
      // Sweep every cursor: even a recent push can miss mail outside its search window.
      const stale = await findCredentialsNeedingPoll();

      for (const c of stale) {
        await ingestionQueue.add("gmail.poll_history", {
          credentialId: c.credentialId,
          reason: "poll-fallback",
        });
      }

      logger.info(`[ingestion:worker] gmail.poll_sweep enqueued=${stale.length}`);

      return { enqueued: stale.length };
    },

    "gmail.embed_sweep": async () => {
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
      logger.info(
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
    },

    "gmail.media_ingest": async (data) => {
      const result = await runGmailMediaIngest({
        credentialId: data.credentialId,
        messageId: data.messageId,
        documentId: data.documentId,
      });

      logger.info(
        `[ingestion:worker] gmail.media_ingest message=${data.messageId} ${formatMediaTally(result)}`,
      );

      return result;
    },

    "user_model.gmail_kind_refold": async (data) => runGmailKindRefoldJob(data.userId),

    "user_model.gmail_kind_refold_sweep": async () => scheduleGmailKindRefoldSweep({}),

    "triage.relabel": async (data) => {
      // One label writer for classifier and user overrides.
      const result = await runGmailTriageRelabel({
        userId: data.userId,
        sourceThreadId: data.sourceThreadId,
      });

      if (result.applied) {
        logger.info(
          `[ingestion:worker] triage.relabel thread=${data.sourceThreadId} applied=true label=${result.appliedLabelId}`,
        );
      } else if (result.reason === "writes-disabled") {
        // #278: expected in non-prod. The DB row is canonical.
        logger.info(
          `[ingestion:worker] triage.relabel thread=${data.sourceThreadId} skipped reason=writes-disabled`,
        );
      } else {
        // Never silent: the thread looks untagged in Gmail (#277).
        logger.error(
          `[ingestion:worker] triage.relabel thread=${data.sourceThreadId} NOT applied reason=${result.reason}`,
        );
      }

      return result;
    },

    "media.cleanup": async (data) =>
      cleanupChatMediaPrefix({ userId: data.userId, prefix: data.prefix }),

    "media.enrich": async (data) =>
      enrichChatMedia({
        userId: data.userId,
        attachmentId: data.attachmentId,
        estimatedCostMicrousd: data.estimatedCostMicrousd,
      }),

    "media.cleanup_pending_upload": async (data) =>
      cleanupPendingChatMediaUploads({ userId: data.userId, keys: data.keys }),

    "ingress.deliver": async (data) => deliverInboundReceipt(data.receiptId),

    "ingress.health_sweep": async () => runDeliveryAlertSweepForAllUsers(),
  },
  schedules: [
    {
      kind: "gmail.poll_sweep",
      repeat: { every: GMAIL_POLL_SWEEP_INTERVAL_MS },
      opts: {
        attempts: 3,
        backoff: { type: "exponential", delay: 30_000 },
        removeOnComplete: { count: 20, age: 24 * 60 * 60 },
        removeOnFail: { count: 50, age: 7 * 24 * 60 * 60 },
      },
    },
    {
      kind: "gmail.watch_renew",
      repeat: { every: 6 * 60 * 60 * 1000 },
      opts: {
        attempts: 3,
        backoff: { type: "exponential", delay: 60_000 },
        removeOnComplete: { count: 10, age: 7 * 24 * 60 * 60 },
        removeOnFail: { count: 30, age: 30 * 24 * 60 * 60 },
      },
    },
    {
      kind: "gmail.embed_sweep",
      repeat: { every: 10 * 60 * 1000 },
      opts: {
        attempts: 2,
        backoff: { type: "exponential", delay: 30_000 },
        removeOnComplete: { count: 20, age: 24 * 60 * 60 },
        removeOnFail: { count: 50, age: 7 * 24 * 60 * 60 },
      },
    },
    {
      kind: "ingress.health_sweep",
      repeat: { every: 6 * 60 * 60 * 1000 },
      opts: {
        attempts: 3,
        backoff: { type: "exponential", delay: 60_000 },
        removeOnComplete: { count: 10, age: 7 * 24 * 60 * 60 },
        removeOnFail: { count: 30, age: 30 * 24 * 60 * 60 },
      },
    },
    {
      kind: "user_model.gmail_kind_refold_sweep",
      repeat: { every: 24 * 60 * 60 * 1000 },
      opts: {
        attempts: 2,
        backoff: { type: "exponential", delay: 60_000 },
        removeOnComplete: { count: 7, age: 30 * 24 * 60 * 60 },
        removeOnFail: { count: 30, age: 30 * 24 * 60 * 60 },
      },
    },
  ],
});
