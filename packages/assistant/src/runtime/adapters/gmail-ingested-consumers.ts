import { mapConcurrent, runTaskGroup, toMessage } from "@alfred/contracts";
import { indexDocument } from "@alfred/corpus";
import { db } from "@alfred/db";
import { documents, emailTriage } from "@alfred/db/schemas";
import { and, eq, inArray } from "drizzle-orm";
import {
  gmailDocumentsIngestedPayloadSchema,
  publishDomainEvent,
  publishEvent,
  TriggerConsumerBootError,
  type DomainEvent,
  type GmailDocumentsIngestedPayload,
  type GmailMessageEventReason,
  type TriggerConsumer,
} from "@alfred/assistant/triggers";
import {
  captureGmailObservations,
  runGmailPostInsertTriage,
  type GmailPostInsertTriageResult,
} from "@alfred/assistant/connections/ingestion";

/**
 * Consumers of the `gmail.documents_ingested` fact (ADR-0089). The producer
 * imports none of them. All are `best-effort`, so the seam swallows their
 * failures. Only a `TriggerConsumerBootError` propagates and fails the job.
 */

const REALTIME_EMIT_CONCURRENCY = 10;

const REALTIME_EMBED_CONCURRENCY = 4;

export const FULL_RESYNC_REPLY_REEVAL_THREAD_LIMIT = 25;

const REPLY_REEVAL_QUERY_CHUNK_SIZE = 1000;

type GmailInsertJobKind = GmailDocumentsIngestedPayload["jobKind"];

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
  fullResync?: boolean | undefined;
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

/**
 * One `gmail.message_received` per inserted document. Per-event failures are
 * logged, so a finished ingestion write never retries. A missing consumer
 * (`TriggerConsumerBootError`) rethrows to expose the broken boot.
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
      `[ingestion:consumer] failed to resolve Gmail event accounts user=${userId}:`,
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
      if (err instanceof TriggerConsumerBootError) throw err;
      console.warn(
        `[ingestion:consumer] failed to emit gmail.message_received for doc=${documentId}:`,
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
      `[ingestion:consumer] reply re-eval skipped sentDocs=${plan.skippedReplyReevalSentDocs} ` +
        `credential=${credentialId}`,
    );
  }

  const skippedReplyReevalThreads = allReplyReevalRequests.length - replyReevalRequests.length;

  if (skippedReplyReevalThreads > 0) {
    console.warn(
      `[ingestion:consumer] reply re-eval skipped threads=${skippedReplyReevalThreads} ` +
        `credential=${credentialId}`,
    );
  }
}

/**
 * Re-triage a thread when the user replies (#282). Sent mail is never triaged
 * (ADR-0051 #7), so this re-keys the classify on the thread's newest inbound
 * document with `force`. Best-effort: failures are logged.
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

    // Only triaged threads. An outbound-first thread has no inbound doc to classify.
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
      `[ingestion:consumer] resolveReplyReevalRequests failed user=${userId}:`,
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
          if (err instanceof TriggerConsumerBootError) throw err;
          console.warn(
            `[ingestion:consumer] reply re-eval failed thread=${threadId}:`,
            toMessage(err),
          );
        }
      },
    );
  } catch (err) {
    if (err instanceof TriggerConsumerBootError) throw err;
    console.warn(
      `[ingestion:consumer] reEvaluateRepliedThreads failed user=${userId}:`,
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

/** Tell the rail to refetch. A missed event only delays a refresh; the rail also polls every 5 minutes. */
async function publishInboxUpdate(userId: string, count: number): Promise<void> {
  // The schema caps `count` at 10_000, and no client reads it, so clamp.
  const payload = { reason: "ingested", count: Math.min(count, 10_000) } as const;
  await publishEvent({ untransacted: true, userId, kind: "inbox.updated", payload });
}

/**
 * Best-effort embed. `gmail.embed_sweep` retries failures. Kept off the triage
 * path so embed latency does not add to tag latency (ADR-0037).
 */
async function embedDocuments(documentIds: readonly string[]): Promise<void> {
  await mapConcurrent(documentIds, REALTIME_EMBED_CONCURRENCY, async (documentId) => {
    try {
      await indexDocument({ documentId });
    } catch (err) {
      console.warn(
        `[ingestion:consumer] gmail embed failed for doc=${documentId}:`,
        toMessage(err),
      );
    }
  });
}

function parseDocumentsIngested(
  event: DomainEvent,
): { userId: string; payload: GmailDocumentsIngestedPayload } | null {
  if (event.source !== "gmail" || event.type !== "documents_ingested") return null;

  return {
    userId: event.userId,
    payload: gmailDocumentsIngestedPayloadSchema.parse(event.payload ?? {}),
  };
}

/** The four consumers of `gmail.documents_ingested`, installed by `registerTriggerConsumers`. */
export function gmailIngestedTriggerConsumers(): TriggerConsumer[] {
  return [
    {
      name: "gmail-corpus-index",
      mode: "best-effort",
      accept: async (event) => {
        const parsed = parseDocumentsIngested(event);

        if (!parsed || !parsed.payload.unembeddedDocumentIds.length) return;
        await embedDocuments(parsed.payload.unembeddedDocumentIds);
      },
    },
    {
      name: "gmail-user-model-capture",
      mode: "best-effort",
      accept: async (event) => {
        const parsed = parseDocumentsIngested(event);

        if (!parsed || !parsed.payload.insertedDocumentIds.length) return;
        await captureGmailObservations({
          userId: parsed.userId,
          documentIds: parsed.payload.insertedDocumentIds,
        });
      },
    },
    {
      name: "gmail-inbox-rail",
      mode: "best-effort",
      accept: async (event) => {
        const parsed = parseDocumentsIngested(event);

        if (!parsed || !parsed.payload.insertedDocumentIds.length) return;
        await publishInboxUpdate(parsed.userId, parsed.payload.insertedDocumentIds.length);
      },
    },
    {
      name: "gmail-triage-postinsert",
      mode: "best-effort",
      accept: async (event) => {
        const parsed = parseDocumentsIngested(event);

        if (!parsed) return;
        const { userId, payload } = parsed;

        const plan = planGmailPostInsertSideEffects({
          jobKind: payload.jobKind,
          triageInsertedDocs: payload.triageInsertedDocs,
          fullResync: payload.fullResync,
          triageDocumentIds: payload.triageDocumentIds,
          sentDocumentIds: payload.sentDocumentIds,
          touchedThreadIds: payload.touchedThreadIds,
        });

        // Different tables, so run both concurrently under one abort scope.
        await runTaskGroup([
          async () => {
            if (plan.triageReason) {
              await emitGmailMessageEvents(userId, plan.triageDocumentIds, plan.triageReason);
            }
          },
          async () => {
            await runGmailRepairSideEffects(payload.credentialId, userId, plan);
          },
        ]);
      },
    },
  ];
}
