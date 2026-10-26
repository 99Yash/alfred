import { db, type DbTransaction } from "@alfred/db";
import { eventsOutbox } from "@alfred/db/schemas";
import {
  EFFECTIVE_AUTHOR,
  EVENT_TYPES_BY_SOURCE,
  INBOUND_EVENT_SOURCES,
  isInboundEventSource,
  jsonObjectSchema,
  RAW_EVENT_TYPE,
  rawEventKindSchema,
  replyDraftTriageSnapshotSchema,
  type EventTypeForSource,
  type InboundEventSource,
  type InProcessEventSource,
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

const gmailMessagePayloadSchema = z
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
const emailTriageClassifiedPayloadSchema = z
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
const gmailDocumentsIngestedPayloadSchema = z
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
const inboundDeliveryPayloadSchema = z
  .object({
    receiptId: z.string().min(1).max(200),
    deliveryKey: z.string().min(1).max(500),
  })
  .strict();

/** One in-process `(source, type)` and its payload rule. Strict, so `rawKind` is refused. */
function inProcessEvent<
  const S extends InProcessEventSource,
  const T extends EventTypeForSource<S>,
  P extends z.ZodType,
>(source: S, type: T, payload: P) {
  return z
    .object({
      ...domainEventIdentityShape,
      source: z.literal(source),
      type: z.literal(type),
      payload,
    })
    .strict();
}

/** Every declared type of one inbound source, with the receipt pointer (ADR-0097). */
function inboundEvent<const S extends InboundEventSource>(source: S) {
  return z
    .object({
      ...domainEventIdentityShape,
      source: z.literal(source),
      type: z.enum(EVENT_TYPES_BY_SOURCE[source]),
      payload: inboundDeliveryPayloadSchema,
    })
    .strict();
}

/**
 * One member per declared in-process `(source, type)`. The `satisfies` fails to compile
 * when a declared type has no member, or a member names another `(source, type)`.
 * `message_received` keeps an optional payload: existing tests call `acceptEvent` with none.
 */
const IN_PROCESS_EVENT_SCHEMAS = {
  gmail: {
    message_received: inProcessEvent(
      "gmail",
      "message_received",
      gmailMessagePayloadSchema.optional(),
    ),
    documents_ingested: inProcessEvent(
      "gmail",
      "documents_ingested",
      gmailDocumentsIngestedPayloadSchema,
    ),
  },
  "email-triage": {
    classified: inProcessEvent("email-triage", "classified", emailTriageClassifiedPayloadSchema),
    reply_worthy: inProcessEvent("email-triage", "reply_worthy", jsonObjectSchema.optional()),
  },
  "google.oauth.callback": {
    completed: inProcessEvent("google.oauth.callback", "completed", jsonObjectSchema.optional()),
  },
  "learn-skill": {
    completed: inProcessEvent("learn-skill", "completed", jsonObjectSchema.optional()),
  },
} satisfies {
  [S in InProcessEventSource]: {
    [T in EventTypeForSource<S>]: z.ZodType<{ source: S; type: T }>;
  };
};

/** One member per inbound source. The `satisfies` fails to compile when a source has none. */
const INBOUND_EVENT_SCHEMAS = {
  github: inboundEvent("github"),
  sentry: inboundEvent("sentry"),
} satisfies {
  [S in InboundEventSource]: z.ZodType<{ source: S; type: EventTypeForSource<S> }>;
};

/**
 * A raw delivery (#990): an inbound source, `type: "raw"`, and the provider kind in `rawKind`.
 * Only this member has `rawKind`, and no in-process member accepts `raw`.
 */
const rawInboundEventSchema = z
  .object({
    ...domainEventIdentityShape,
    source: z.enum(INBOUND_EVENT_SOURCES),
    type: z.literal(RAW_EVENT_TYPE),
    rawKind: rawEventKindSchema,
    payload: inboundDeliveryPayloadSchema,
  })
  .strict();

/**
 * The source/type taxonomy lives in `@alfred/contracts`; this adds the payload rule per
 * `(source, type)`. A new leaf in the tables above must also be listed here.
 */
export const domainEventSchema = z.union([
  IN_PROCESS_EVENT_SCHEMAS.gmail.message_received,
  IN_PROCESS_EVENT_SCHEMAS.gmail.documents_ingested,
  IN_PROCESS_EVENT_SCHEMAS["email-triage"].classified,
  IN_PROCESS_EVENT_SCHEMAS["email-triage"].reply_worthy,
  IN_PROCESS_EVENT_SCHEMAS["google.oauth.callback"].completed,
  IN_PROCESS_EVENT_SCHEMAS["learn-skill"].completed,
  INBOUND_EVENT_SCHEMAS.github,
  INBOUND_EVENT_SCHEMAS.sentry,
  rawInboundEventSchema,
]);

export type DomainEvent = z.output<typeof domainEventSchema>;

/** An event from an inbound webhook, typed or raw. Its payload is the receipt pointer. */
export type InboundDomainEvent = Extract<DomainEvent, { source: InboundEventSource }>;

export function isInboundDomainEvent(event: DomainEvent): event is InboundDomainEvent {
  return isInboundEventSource(event.source);
}

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
  accept(event: DomainEvent): Promise<void>;
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
