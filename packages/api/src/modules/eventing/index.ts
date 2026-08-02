import { jsonObjectSchema } from "@alfred/contracts";
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

export const domainEventSchema = z.discriminatedUnion("source", [
  z
    .object({
      ...domainEventIdentityShape,
      source: z.literal("gmail"),
      type: z.literal("message_received"),
      payload: gmailMessagePayloadSchema.optional(),
    })
    .strict(),
  z
    .object({
      ...domainEventIdentityShape,
      source: z.literal("google.oauth.callback"),
      type: z.literal("completed"),
      payload: jsonObjectSchema.optional(),
    })
    .strict(),
  z
    .object({
      ...domainEventIdentityShape,
      source: z.literal("learn-skill"),
      type: z.literal("completed"),
      payload: jsonObjectSchema.optional(),
    })
    .strict(),
]);

export type DomainEvent = z.infer<typeof domainEventSchema>;

export interface PublishedEvent {
  delivered: number;
}

export interface EventConsumer {
  name: string;
  accept(event: DomainEvent): Promise<unknown>;
}

/**
 * Register one durable consumer during runtime composition.
 *
 * The returned function removes that exact registration during teardown or a
 * test. Product modules publish through this module and never import the
 * consumers that react to the event.
 */
export function registerEventConsumer(consumer: EventConsumer): () => void {
  return registerConsumer(consumer);
}

/**
 * Publish one application domain event to every registered consumer.
 *
 * Event delivery is in-process. Each consumer owns its durable claim before it
 * performs asynchronous work, so a producer retry cannot create duplicate
 * work. A consumer failure rejects publication after all consumers have had a
 * chance to claim the event.
 */
export async function publish(event: DomainEvent): Promise<PublishedEvent> {
  return publishToConsumers(domainEventSchema.parse(event));
}
