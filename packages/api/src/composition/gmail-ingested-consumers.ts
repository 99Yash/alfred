import { mapConcurrent, runTaskGroup, toMessage } from "@alfred/contracts";
import { indexDocument } from "@alfred/corpus";
import { db } from "@alfred/db";
import { documents, emailTriage } from "@alfred/db/schemas";
import { and, eq, inArray } from "drizzle-orm";
import { publishEvent } from "../events/publish";
import {
  gmailDocumentsIngestedPayloadSchema,
  NoTriggerConsumersRegisteredError,
  publishDomainEvent,
  type DomainEvent,
  type GmailDocumentsIngestedPayload,
  type GmailMessageEventReason,
  type TriggerConsumer,
} from "../modules/triggers";
import {
  runGmailPostInsertTriage,
  type GmailPostInsertTriageResult,
} from "../modules/integrations/gmail-triage";
import {
  captureGmailObservations,
  NoGmailUserModelHandlerRegisteredError,
} from "../modules/integrations/gmail-user-model";

/**
 * Composition adapters for the `gmail.documents_ingested` batch fact (ADR-0089).
 *
 * `queue.ts` publishes one fact per completed Gmail insert job and imports none
 * of these reactions; each independent downstream (corpus embed, user-model
 * capture, inbox rail, triage post-insert) subscribes here as a registered
 * trigger consumer. This inverts the old direct fan-out so the connection layer
 * only states the fact and every reacting module owns its own policy.
 *
 * `publishToConsumers` rejects the WHOLE publish via `AggregateError` if any
 * consumer's `accept` throws, and that rejection would fail the ingestion job —
 * a thing the old per-effect-swallowing fan-out never did. So every consumer
 * keeps the original swallow-and-log wrapper internally; only a runtime-
 * composition boot failure (the `No*RegisteredError` family) is allowed to
 * propagate, exactly as the old fan-out let it fail the job.
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
 * Emit one Gmail message event per freshly-inserted Gmail document. Event-level
 * failures are logged-and-swallowed so trigger dispatch does not fail an
 * ingestion job that successfully wrote the docs. A missing consumer is a
 * runtime-composition failure instead: it rejects so retries and monitoring
 * expose the broken boot path. Strict schema drift stays an event-level failure
 * and warns instead of retrying the completed ingestion write.
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
      if (err instanceof NoTriggerConsumersRegisteredError) throw err;
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
 * Re-evaluate a thread's triage tag when the user sends an outbound reply
 * (issue #282). Sent mail is ingested + embedded but deliberately never
 * triaged/labeled and never a sender prior (ADR-0051 #7) — so the kept
 * "re-evaluate on reply" contract only ever fired on INBOUND replies, freezing
 * the tag until the counterparty sent again.
 *
 * We preserve both ADR-0051 #7 guardrails by NOT triaging the sent doc: instead
 * we re-key the received-only classify on the thread's newest INBOUND doc and
 * pass `force` so the already-tagged skip guard re-classifies. Best-effort:
 * failures are logged, never bubbled into the ingest result.
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
          if (err instanceof NoTriggerConsumersRegisteredError) throw err;
          console.warn(
            `[ingestion:consumer] reply re-eval failed thread=${threadId}:`,
            toMessage(err),
          );
        }
      },
    );
  } catch (err) {
    if (err instanceof NoTriggerConsumersRegisteredError) throw err;
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
      `[ingestion:consumer] user-model gmail observation capture failed user=${userId}:`,
      toMessage(err),
    );
  }
}

/**
 * Best-effort `inbox.updated` notification — fires the SSE bus so the chat
 * right-rail can invalidate its `["me","inbox"]` query without polling. We
 * coalesce per-job (one event per N inserts). Failures are swallowed-and-logged:
 * a missed SSE frame is a missed refresh, not a missed write — the rail's 5-min
 * poll backstops it.
 */
async function publishInboxUpdate(userId: string, count: number): Promise<void> {
  try {
    // `inboxUpdatedSchema` caps `count` at 10_000; a bulk back-catalog re-ingest
    // can exceed that. The count is telemetry-only (clients don't act on it), so
    // clamp instead of letting validation throw and lose the refresh signal.
    const payload = { reason: "ingested", count: Math.min(count, 10_000) } as const;
    await publishEvent({ untransacted: true, userId, kind: "inbox.updated", payload });
  } catch (err) {
    console.warn(`[ingestion:consumer] publishInboxUpdate failed user=${userId}:`, toMessage(err));
  }
}

/**
 * Embed docs still needing an embed in parallel. Best-effort: failures are
 * logged and left for `gmail.embed_sweep` to retry. Kept off the triage-enqueue
 * critical path so Voyage latency doesn't compound into the user-visible
 * tag-latency budget (ADR-0037).
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

/** Narrow a published event to the Gmail batch fact this file reacts to. */
function parseDocumentsIngested(
  event: DomainEvent,
): { userId: string; payload: GmailDocumentsIngestedPayload } | null {
  if (event.source !== "gmail" || event.type !== "documents_ingested") return null;
  return {
    userId: event.userId,
    payload: gmailDocumentsIngestedPayloadSchema.parse(event.payload ?? {}),
  };
}

/**
 * The four consumers that react to `gmail.documents_ingested`. Registered
 * through `registerTriggerConsumers` (composition), never imported by the
 * producer. Every accept ignores any other event and swallows its own errors
 * internally so one best-effort reaction cannot fail the publish.
 */
export function gmailIngestedTriggerConsumers(): TriggerConsumer[] {
  return [
    {
      name: "gmail-corpus-index",
      accept: async (event) => {
        const parsed = parseDocumentsIngested(event);
        if (!parsed || !parsed.payload.unembeddedDocumentIds.length) return;
        await embedDocuments(parsed.payload.unembeddedDocumentIds);
      },
    },
    {
      name: "gmail-user-model-capture",
      accept: async (event) => {
        const parsed = parseDocumentsIngested(event);
        if (!parsed || !parsed.payload.insertedDocumentIds.length) return;
        await runGmailObservationCapture(parsed.userId, parsed.payload.insertedDocumentIds);
      },
    },
    {
      name: "gmail-inbox-rail",
      accept: async (event) => {
        const parsed = parseDocumentsIngested(event);
        if (!parsed || !parsed.payload.insertedDocumentIds.length) return;
        await publishInboxUpdate(parsed.userId, parsed.payload.insertedDocumentIds.length);
      },
    },
    {
      name: "gmail-triage-postinsert",
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
        // The two triage reactions target different tables and each swallows its
        // own errors, so run them concurrently under one abort scope — the same
        // shape the old queue.ts fan-out used.
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
