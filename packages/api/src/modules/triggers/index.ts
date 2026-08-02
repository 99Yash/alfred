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

const domainEventIdentityShape = {
  userId: z.string().min(1).max(200),
  eventId: z.string().min(1).max(500),
  /** Provider account that produced the event, for account-bound consumers. */
  accountRef: z.string().min(1).max(200).optional(),
};

const gmailMessagePayloadSchema = z
  .object({
    documentId: z.string().min(1).max(200).optional(),
    reason: z.enum(["webhook", "manual", "ingest", "reply"]).optional(),
    force: z.boolean().optional(),
  })
  .strict();

const payloadSchemaBySource: Record<EventSource, z.ZodType<unknown>> = {
  gmail: gmailMessagePayloadSchema,
  "google.oauth.callback": jsonObjectSchema,
  "learn-skill": jsonObjectSchema,
};

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
    const parsedPayload = payloadSchemaBySource[event.source].safeParse(event.payload);
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

export interface TriggerConsumer {
  name: string;
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
export async function publish(event: DomainEvent): Promise<PublishedEvent> {
  return publishToConsumers(domainEventSchema.parse(event));
}
