import {
  isEventSource,
  isEventType,
  isEventTypeForSource,
  jsonObjectSchema,
  type EventSource,
  type EventType,
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

export const gmailMessagePayloadSchema = z
  .object({
    documentId: z.string().min(1).max(200).optional(),
    reason: z.enum(["webhook", "manual", "ingest", "reply"]).optional(),
    force: z.boolean().optional(),
  })
  .strict();

export type GmailMessageEventReason = NonNullable<
  z.infer<typeof gmailMessagePayloadSchema>["reason"]
>;

/** The three Gmail insert job kinds that can raise `gmail.documents_ingested`. */
export const GMAIL_INSERT_JOB_KINDS = [
  "gmail.ingest_recent",
  "gmail.poll_recent",
  "gmail.poll_history",
] as const;

// Defensive process-local bounds; a real ingest batch is far smaller.
const ingestedIdListSchema = z.array(z.string().min(1).max(500)).max(10_000);

/**
 * The batch fact `queue.ts` publishes after a Gmail insert job: the raw document
 * sets, with no pre-computed side-effect plan. Each consumer (corpus embed,
 * user-model capture, inbox rail, triage post-insert) owns its own policy over
 * these fields. `unembeddedDocumentIds` is the docs still needing an embed — the
 * realtime inserts on `poll_recent`, and `[]` on the bulk/catch-up paths, which
 * embed inline in the ingestor — so the corpus consumer never double-embeds.
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

/**
 * The strict payload rule for one `source`/`type` pair. Gmail owns two distinct
 * facts — the per-received-doc `message_received` and the batch
 * `documents_ingested` — so its schema is chosen by `type`. Every other source
 * validates its payload as an opaque JSON object.
 */
function payloadSchemaFor(source: EventSource, type: EventType): z.ZodType<unknown> {
  if (source === "gmail") {
    return type === "documents_ingested"
      ? gmailDocumentsIngestedPayloadSchema
      : gmailMessagePayloadSchema;
  }
  return jsonObjectSchema;
}

/**
 * The legal source/type taxonomy stays owned by `@alfred/contracts` because it
 * also shapes persisted run identity and browser workflow authoring. This
 * module adds only the source-specific payload rule it owns.
 */
export const domainEventSchema = z
  .object({
    ...domainEventIdentityShape,
    source: z.custom<EventSource>(
      (value) => typeof value === "string" && isEventSource(value),
      "Unknown event source",
    ),
    type: z.custom<EventType>(
      (value) => typeof value === "string" && isEventType(value),
      "Unknown event type",
    ),
    payload: jsonObjectSchema.optional(),
  })
  .strict()
  .superRefine((event, context) => {
    if (!isEventTypeForSource(event.source, event.type)) {
      context.addIssue({
        code: "custom",
        message: `Event type '${event.type}' is invalid for source '${event.source}'`,
        path: ["type"],
      });
    }

    if (event.payload === undefined) return;
    const parsedPayload = payloadSchemaFor(event.source, event.type).safeParse(event.payload);
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
 * How the seam treats a consumer's own `accept` failure.
 *
 * - `best-effort`: the reaction is a side effect that must never fail the
 *   publish — its non-boot rejection is logged and swallowed at the seam. The
 *   producer (e.g. a completed ingestion write) cannot be rolled back by a
 *   reaction that failed.
 * - `propagate`: the consumer's rejection is a first-class failure and rejects
 *   the publish exactly as an unhandled consumer error always has.
 *
 * A `TriggerConsumerBootError` is exempt from the `best-effort` swallow — a
 * broken boot path still fails the publish so it surfaces on retry.
 */
export type TriggerConsumerMode = "best-effort" | "propagate";

export interface TriggerConsumer {
  name: string;
  /** Required so a new consumer cannot compile without choosing how the seam
   *  treats its failures — the swallow rule lives here as data, not as prose. */
  mode: TriggerConsumerMode;
  accept(event: DomainEvent): Promise<unknown>;
}

/**
 * Register one durable trigger consumer during runtime composition.
 *
 * The returned function removes that exact registration during teardown or a
 * test. Product modules publish through this module and never import the
 * consumers that react to the event.
 */
export function registerTriggerConsumer(consumer: TriggerConsumer): () => void {
  return registerConsumer(consumer);
}

/**
 * Publish one application domain event to every registered trigger consumer.
 *
 * Delivery is in-process. `acceptedConsumers` counts consumers whose `accept`
 * method returned normally; consumer-specific result details stay private to
 * that consumer. A thrown consumer failure rejects publication after every
 * registered consumer has been called.
 */
export async function publishDomainEvent(event: DomainEvent): Promise<PublishedEvent> {
  return publishToConsumers(domainEventSchema.parse(event));
}
