import { z } from "zod";
import { defineQueue, job, type JobInput, keyedJob, signal } from "@alfred/assistant/queue-jobs";
import { claimChatMediaEnrichment, recordChatMediaEnqueueFailure } from "./chat-media";
import { GMAIL_POLL_DEDUP_TTL_MS, gmailPollHistoryReasonSchema } from "./gmail-delivery-policy";

/**
 * Ingestion queue: Gmail sync, chat media, user-model refolds and inbound receipt delivery.
 * The worker and its schedules are `worker.ts`. Each kind owns its dedup or job-id rule
 * (ADR-0032), so a producer passes only the data.
 */

const GMAIL_MEDIA_INGEST_DEDUP_TTL_MS = 60_000;

const USER_MODEL_GMAIL_REFOLD_DEDUP_TTL_MS = 10 * 60 * 1000;

const PENDING_UPLOAD_CLEANUP_DELAY_MS = 24 * 60 * 60 * 1000;

const credential = z.object({ credentialId: z.string() });

export const ingestionQueue = defineQueue({
  name: "ingestion-runs",
  defaults: {
    // The DB unique index makes retries safe.
    attempts: 5,
    backoff: { type: "exponential", delay: 5_000 },
    removeOnComplete: { count: 50, age: 24 * 60 * 60 },
    removeOnFail: { count: 100, age: 7 * 24 * 60 * 60 },
  },
  jobs: {
    "gmail.ingest_recent": job(
      credential.extend({
        query: z.string().optional(),
        maxMessages: z.number().optional(),
        /**
         * Emit triage events for the inserts. Default false, so bulk backlogs do not burn LLM
         * tokens. The OAuth callback opts in for the small first-connect seed.
         */
        triageInsertedDocs: z.boolean().optional(),
      }),
    ),

    "gmail.poll_recent": job(
      credential.extend({
        /** Pub/Sub push historyId, for gap detection (#560b). */
        pushHistoryId: z.string().optional(),
        /**
         * The one follow-up a poll that ended below its burst's receipts schedules (ingest-lag
         * fix). A depth-0 poll may spawn it; the follow-up never spawns one, so a push that no
         * recent poll can cover falls back to the sweep.
         */
        followUp: z.boolean().optional(),
      }),
      // A TTL dedup collapses push bursts. Not a static `jobId`: BullMQ keeps completed jobs, so a
      // reused id is a silent no-op for hours. The follow-up needs its own id: the depth-0 job's
      // dedup key still covers the window the follow-up adds inside.
      (d) => ({
        deduplication: {
          id: d.followUp
            ? `gmail.poll_recent.followup.${d.credentialId}`
            : `gmail.poll_recent.${d.credentialId}`,
          ttl: GMAIL_POLL_DEDUP_TTL_MS,
        },
        // Runs after the dedup window, giving Gmail's search index a beat to file the message
        // the first list missed (ADR-0037).
        ...(d.followUp ? { delay: GMAIL_POLL_DEDUP_TTL_MS } : {}),
      }),
    ),

    "gmail.poll_history": job(
      credential.extend({ reason: gmailPollHistoryReasonSchema.optional() }),
      // One waiting poll plus at most one follow-up while a poll runs.
      (d) => ({
        deduplication: { id: `gmail.poll_history.${d.credentialId}`, keepLastIfActive: true },
      }),
    ),

    /**
     * Install the Gmail watch for a new credential (ADR-0037), so push starts at once.
     * `gmail.watch_renew` also installs a missing watch, but only at its
     * `GMAIL_WATCH_RENEW_INTERVAL_MS` cadence (6 hours, in `worker.ts`).
     */
    "gmail.watch_install": job(credential),

    "gmail.watch_renew": signal(),

    "gmail.poll_sweep": signal(),

    "gmail.embed_sweep": signal(),

    "ingress.health_sweep": signal(),

    /** Deferred attachment ingest for one message (ADR-0091 amendment). Idempotent. */
    "gmail.media_ingest": job(
      credential.extend({
        messageId: z.string(),
        /** Mail document that carries the `mediaPending` flag. */
        documentId: z.string(),
      }),
      // The dedup TTL collapses concurrent schedules. Gmail message ids are mailbox-scoped, so
      // the id keeps linked-account schedules distinct.
      (d) => ({
        deduplication: {
          id: `gmail.media_ingest.${d.credentialId}.${d.messageId}`,
          ttl: GMAIL_MEDIA_INGEST_DEDUP_TTL_MS,
        },
      }),
    ),

    /** Re-project the active Gmail kind user-model. No active projection means no-op. */
    "user_model.gmail_kind_refold": job(z.object({ userId: z.string() }), (d) => ({
      deduplication: {
        id: `user_model.gmail_kind_refold.${d.userId}`,
        ttl: USER_MODEL_GMAIL_REFOLD_DEDUP_TTL_MS,
      },
      attempts: 2,
      backoff: { type: "exponential", delay: 60_000 },
      removeOnComplete: { count: 20, age: 24 * 60 * 60 },
      removeOnFail: { count: 50, age: 7 * 24 * 60 * 60 },
    })),

    /**
     * Backstop: refold every user with an active projection, in case a live refold was missed.
     * The fan-out never activates; each refold still passes the frozen-logic gate.
     */
    "user_model.gmail_kind_refold_sweep": signal(),

    /** Sync one thread's Gmail label to its `email_triage` category after a user override. */
    "triage.relabel": job(z.object({ userId: z.string(), sourceThreadId: z.string() }), (d) => ({
      deduplication: {
        id: `triage.relabel.${d.userId}.${d.sourceThreadId}`,
        keepLastIfActive: true,
      },
    })),

    "media.enrich": keyedJob(
      z.object({
        userId: z.string(),
        attachmentId: z.string(),
        estimatedCostMicrousd: z.number(),
      }),
      { key: ["attachmentId"], id: ({ attachmentId }) => `media-enrich.${attachmentId}` },
    ),

    /** Delete chat attachment bytes under a key prefix (ADR-0065). Storage has no FK cascade. */
    "media.cleanup": job(z.object({ userId: z.string(), prefix: z.string() }), (d) => ({
      deduplication: { id: `media.cleanup.${d.prefix}` },
    })),

    /** Delete uploads that never got a `chat_attachments` row. A no-op once `/turn` saved the key. */
    "media.cleanup_pending_upload": job(
      z.object({ userId: z.string(), keys: z.array(z.string()) }),
      (d) => ({
        delay: PENDING_UPLOAD_CLEANUP_DELAY_MS,
        deduplication: { id: `media.cleanup_pending_upload.${d.keys.join(",")}` },
      }),
    ),

    /**
     * Publish one `event_receipts` row to the trigger bus (ADR-0097). The job id is the receipt id,
     * so a redelivery is a no-op while the job exists. BullMQ refuses a duplicate `jobId` in every
     * state, failed too, so `removeOnFail: true` lets a redelivery revive a failed receipt.
     */
    "ingress.deliver": keyedJob(z.object({ receiptId: z.string() }), {
      key: ["receiptId"],
      id: ({ receiptId }) => `ingress.deliver.${receiptId}`,
      options: () => ({ removeOnFail: true }),
    }),
  },
});

/** Delete chat attachment bytes for a deleted thread or account (ADR-0065). Dedups per prefix. */
export async function enqueueChatStorageCleanup(userId: string, prefix: string): Promise<void> {
  await ingestionQueue.add("media.cleanup", { userId, prefix });
}

export async function enqueuePendingUploadCleanup(userId: string, key: string): Promise<void> {
  await ingestionQueue.add("media.cleanup_pending_upload", { userId, keys: [key] });
}

export async function enqueueInboundDelivery(receiptId: string): Promise<void> {
  await ingestionQueue.add("ingress.deliver", { receiptId });
}

export async function enqueueGmailKindRefold(userId: string): Promise<void> {
  await ingestionQueue.add("user_model.gmail_kind_refold", { userId });
}

export async function enqueueTriageRelabel(userId: string, sourceThreadId: string): Promise<void> {
  await ingestionQueue.add("triage.relabel", { userId, sourceThreadId });
}

type ChatEnrichmentRequest = JobInput<typeof ingestionQueue, "media.enrich">;

interface ChatEnrichmentQueueDeps {
  claim(attachmentId: string): Promise<"claimed" | "existing">;
  enqueue(args: ChatEnrichmentRequest): Promise<void>;
  recordEnqueueFailure(attachmentId: string): Promise<void>;
}

/** Test seam for the claim, enqueue, failure lifecycle. */
export async function enqueueChatAttachmentEnrichmentWith(
  deps: ChatEnrichmentQueueDeps,
  args: ChatEnrichmentRequest,
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

export async function enqueueChatAttachmentEnrichment(
  args: ChatEnrichmentRequest,
): Promise<"scheduled" | "existing"> {
  return enqueueChatAttachmentEnrichmentWith(
    {
      claim: async (attachmentId) => claimChatMediaEnrichment({ attachmentId }),
      enqueue: async (request) => {
        await ingestionQueue.add("media.enrich", request);
      },
      recordEnqueueFailure: async (attachmentId) => {
        await recordChatMediaEnqueueFailure({ attachmentId });
      },
    },
    args,
  );
}
