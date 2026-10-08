import { db, type DbTransaction } from "@alfred/db";
import { eventsOutbox } from "@alfred/db/schemas";
import {
  EFFECTIVE_AUTHOR,
  isEventSource,
  isEventType,
  isEventTypeForSource,
  isInboundEventSource,
  isRawEventType,
  jsonObjectSchema,
  rawEventKindSchema,
  rawEventTriggerIssue,
  replyDraftTriageSnapshotSchema,
  type EventSource,
  type EventType,
  type RawReceiptType,
  eventPayloadSchemas,
  type EventKind,
  type EventPayload,
} from "@alfred/contracts";
import { z } from "zod";
import { publishToConsumers, registerConsumer } from "./internal/consumer-registry";

export {
  NoTriggerConsumersRegisteredError,
  TriggerConsumerBootError,
} from "./internal/consumer-registry";

const domainEventIdentityShape = {
  userId: z.string().min(1).max(200),
  eventId: z.string().min(1).max(500),
  /** Provider account that produced the event, for account-bound consumers. */
  accountRef: z.string().min(1).max(200).optional(),
};

export const GMAIL_MESSAGE_EVENT_REASONS = ["webhook", "manual", "ingest", "reply"] as const;

export const gmailMessagePayloadSchema = z
  .object({
    documentId: z.string().min(1).max(200).optional(),
    reason: z.enum(GMAIL_MESSAGE_EVENT_REASONS).optional(),
    force: z.boolean().optional(),
  })
  .strict();

export type GmailMessageEventReason = NonNullable<
  z.infer<typeof gmailMessagePayloadSchema>["reason"]
>;

/**
 * Published by triage `classify` once it owns the thread row (ADR-0098).
 * Carries the facts a downstream gate needs without re-reading the row. No body text.
 */
export const emailTriageClassifiedPayloadSchema = z
  .object({
    triage: replyDraftTriageSnapshotSchema,
    /** So a consumer can trace under the same run. */
    triageStep: z.object({
      runId: z.string().min(1),
      stepId: z.string().min(1),
      attempt: z.number().int().nonnegative(),
    }),
    /** `reply` is the outbound-reply re-eval (#282). */
    triageReason: z.enum(GMAIL_MESSAGE_EVENT_REASONS).nullable(),
    sender: z.object({
      /** Canonical `local@domain`, or null when `From:` did not parse. */
      address: z.string().nullable(),
      effectiveAuthor: z.enum(EFFECTIVE_AUTHOR),
    }),
    mailbox: z.object({
      accountId: z.string().min(1),
      /** Null when unknown. */
      address: z.string().nullable(),
    }),
    thread: z.object({
      inboundAuthoredAt: z.iso.datetime().nullable(),
      lastUserReplyAt: z.iso.datetime().nullable(),
      newestDirection: z.enum(["sent", "received"]).nullable(),
    }),
  })
  .strict();

export type EmailTriageClassifiedPayload = z.infer<typeof emailTriageClassifiedPayloadSchema>;

/** Gmail insert jobs that can raise `gmail.documents_ingested`. */
export const GMAIL_INSERT_JOB_KINDS = [
  "gmail.ingest_recent",
  "gmail.poll_recent",
  "gmail.poll_history",
] as const;

// Defensive process-local bounds; a real ingest batch is far smaller.
const ingestedIdListSchema = z.array(z.string().min(1).max(500)).max(10_000);

/**
 * Published by `queue.ts` after a Gmail insert job. Each consumer owns its own policy.
 * `unembeddedDocumentIds` is empty on paths that embed inline, so nothing embeds twice.
 */
export const gmailDocumentsIngestedPayloadSchema = z
  .object({
    credentialId: z.string().min(1).max(500),
    jobKind: z.enum(GMAIL_INSERT_JOB_KINDS),
    triageInsertedDocs: z.boolean().optional(),
    fullResync: z.boolean().optional(),
    insertedDocumentIds: ingestedIdListSchema,
    triageDocumentIds: ingestedIdListSchema,
    sentDocumentIds: ingestedIdListSchema,
    touchedThreadIds: ingestedIdListSchema,
    unembeddedDocumentIds: ingestedIdListSchema,
  })
  .strict();

export type GmailDocumentsIngestedPayload = z.infer<typeof gmailDocumentsIngestedPayloadSchema>;

/** Every inbound webhook publishes a pointer to its `event_receipts` row, never the body (ADR-0097). */
export const inboundDeliveryPayloadSchema = z
  .object({
    receiptId: z.string().min(1).max(200),
    deliveryKey: z.string().min(1).max(500),
  })
  .strict();

export type InboundDeliveryPayload = z.infer<typeof inboundDeliveryPayloadSchema>;

/**
 * Payload rule per `source`/`type`. Gmail picks by `type`. Other in-process sources are
 * listed one by one; the `never` check makes a new source fail to compile until it has a rule.
 */
function payloadSchemaFor(source: EventSource, type: EventType): z.ZodType<unknown> {
  if (isInboundEventSource(source)) return inboundDeliveryPayloadSchema;

  switch (source) {
    case "gmail":
      return type === "documents_ingested"
        ? gmailDocumentsIngestedPayloadSchema
        : gmailMessagePayloadSchema;
    case "email-triage":
      return type === "classified" ? emailTriageClassifiedPayloadSchema : jsonObjectSchema;
    case "google.oauth.callback":
    case "learn-skill":
      return jsonObjectSchema;
    default: {
      const _exhaustive: never = source;

      return _exhaustive;
    }
  }
}

/**
 * The source/type taxonomy lives in `@alfred/contracts`; this adds only the payload rule.
 * A raw event (#990) is `type: "raw"` plus `rawKind`, from `ingress.deliver` only.
 * `raw` equals no declared type, so `source`/`type` matches are unaffected.
 */
export const domainEventSchema = z
  .object({
    ...domainEventIdentityShape,
    source: z.custom<EventSource>(isEventSource, "Unknown event source"),
    type: z.custom<EventType | RawReceiptType>(
      (value) => isEventType(value) || (typeof value === "string" && isRawEventType(value)),
      "Unknown event type",
    ),
    /** Present exactly when `type` is `raw`. */
    rawKind: rawEventKindSchema.optional(),
    payload: jsonObjectSchema.optional(),
  })
  .strict()
  .superRefine((event, context) => {
    // Shared raw pairing rule (#990).
    const tierIssue = rawEventTriggerIssue(event);

    if (tierIssue) {
      context.addIssue({ code: "custom", message: tierIssue.message, path: [tierIssue.path] });
    } else if (!isRawEventType(event.type) && !isEventTypeForSource(event.source, event.type)) {
      context.addIssue({
        code: "custom",
        message: `Event type '${event.type}' is invalid for source '${event.source}'`,
        path: ["type"],
      });
    }

    if (event.payload === undefined) return;

    const schema = isRawEventType(event.type)
      ? inboundDeliveryPayloadSchema
      : payloadSchemaFor(event.source, event.type);

    const parsedPayload = schema.safeParse(event.payload);

    if (parsedPayload.success) return;

    for (const issue of parsedPayload.error.issues) {
      context.addIssue({
        code: "custom",
        message: issue.message,
        path: ["payload", ...issue.path],
      });
    }
  });

export type DomainEvent = z.infer<typeof domainEventSchema>;

export interface PublishedEvent {
  acceptedConsumers: number;
}

/**
 * How the seam treats a consumer's `accept` failure.
 * `best-effort`: log and swallow; a failed reaction cannot undo the producer's write.
 * `propagate`: reject the publish.
 * A `TriggerConsumerBootError` always propagates, so a broken boot shows up on retry.
 */
export type TriggerConsumerMode = "best-effort" | "propagate";

export interface TriggerConsumer {
  name: string;
  /** Required, so every consumer must choose. */
  mode: TriggerConsumerMode;
  accept(event: DomainEvent): Promise<unknown>;
}

/** Register a trigger consumer. Returns the function that removes it. */
export function registerTriggerConsumer(consumer: TriggerConsumer): () => void {
  return registerConsumer(consumer);
}

/**
 * Publish to every registered consumer, in process. A thrown failure rejects
 * the publish after every consumer has run.
 */
export async function publishDomainEvent(event: DomainEvent): Promise<PublishedEvent> {
  return publishToConsumers(domainEventSchema.parse(event));
}

/**
 * The outbox is the only realtime fan-out (ADR-0005), so the caller must pick one:
 * `tx` commits the outbox row with the domain write, so a rollback cannot leak an event.
 * `untransacted: true` is for non-domain publishes such as progress or an SSE poke.
 * Omitting both is a type error.
 */
export type PublishEventArgs<K extends EventKind> = {
  userId: string;
  kind: K;
  payload: EventPayload<K>;
} & ({ tx: DbTransaction; untransacted?: never } | { untransacted: true; tx?: never });

/**
 * Insert one outbox event. Validates first: a bad row replays to clients until
 * `OUTBOX_RETENTION_MS` reaps it (#533). Throws on an invalid payload; that is a bug.
 */
export async function publishEvent<K extends EventKind>(args: PublishEventArgs<K>): Promise<void> {
  const schema = eventPayloadSchemas[args.kind];
  const parsed = schema.safeParse(args.payload);

  if (!parsed.success) {
    throw new Error(
      `[events:publish] payload for kind=${args.kind} failed validation: ${parsed.error.message}`,
    );
  }

  const executor = args.untransacted ? db() : args.tx;
  await executor.insert(eventsOutbox).values({
    userId: args.userId,
    kind: args.kind,
    payload: parsed.data,
  });
}

export interface ReplicachePokeAdapter {
  emitReplicachePokes(userIds: string[], assetId?: string): void;
}

let replicachePokeAdapter: ReplicachePokeAdapter | null = null;

/**
 * Register the Replicache poke adapter. Without one, pokes are dropped.
 * Returns an unregister function.
 */
export function registerReplicachePokeAdapter(adapter: ReplicachePokeAdapter): () => void {
  const prev = replicachePokeAdapter;
  replicachePokeAdapter = adapter;

  return () => {
    replicachePokeAdapter = prev;
  };
}

export function unregisterReplicachePokeAdapter(): void {
  replicachePokeAdapter = null;
}

/**
 * Poke connected clients. Best-effort and never throws: a poke is only a cache hint.
 * A no-op when no adapter is registered (tests, scripts). `RUNTIME_ADAPTERS` registers it at boot.
 */
export function emitReplicachePokes(userIds: string[], assetId?: string): void {
  replicachePokeAdapter?.emitReplicachePokes(userIds, assetId);
}

export interface ChatAttachmentEnrichmentScheduler {
  enqueueChatAttachmentEnrichment(args: {
    userId: string;
    attachmentId: string;
    estimatedCostMicrousd: number;
  }): Promise<"scheduled" | "existing">;
}

let chatAttachmentEnrichmentScheduler: ChatAttachmentEnrichmentScheduler | null = null;

/**
 * Register the enrichment scheduler. Compaction cannot import the ingestion queue
 * without a cycle, so `RUNTIME_ADAPTERS` registers it at boot. Returns an unregister function.
 */
export function registerChatAttachmentEnrichmentScheduler(
  scheduler: ChatAttachmentEnrichmentScheduler,
): () => void {
  const prev = chatAttachmentEnrichmentScheduler;
  chatAttachmentEnrichmentScheduler = scheduler;

  return () => {
    chatAttachmentEnrichmentScheduler = prev;
  };
}

export function unregisterChatAttachmentEnrichmentScheduler(): void {
  chatAttachmentEnrichmentScheduler = null;
}

/**
 * Enqueue enrichment for a chat attachment. Best-effort and never throws.
 * With no scheduler (tests, scripts) it reports `"existing"` and does nothing.
 */
export function enqueueChatAttachmentEnrichment(args: {
  userId: string;
  attachmentId: string;
  estimatedCostMicrousd: number;
}): Promise<"scheduled" | "existing"> {
  return (
    chatAttachmentEnrichmentScheduler?.enqueueChatAttachmentEnrichment(args) ??
    Promise.resolve("existing")
  );
}
