import type { DomainEvent, EventConsumer, PublishedEvent } from "..";

const consumers = new Map<string, EventConsumer>();

export function registerConsumer(consumer: EventConsumer): () => void {
  if (consumers.has(consumer.name)) {
    throw new Error(`[eventing] consumer '${consumer.name}' is already registered`);
  }
  consumers.set(consumer.name, consumer);

  return () => {
    if (consumers.get(consumer.name) === consumer) consumers.delete(consumer.name);
  };
}

export async function publishToConsumers(event: DomainEvent): Promise<PublishedEvent> {
  const registered = [...consumers.values()];
  if (registered.length === 0) {
    throw new Error("[eventing] no consumers are registered");
  }
  const outcomes = await Promise.allSettled(registered.map((consumer) => consumer.accept(event)));
  const failures = outcomes.flatMap((outcome, index) =>
    outcome.status === "rejected"
      ? [{ consumer: registered[index]?.name ?? "unknown", cause: outcome.reason }]
      : [],
  );

  if (failures.length > 0) {
    throw new AggregateError(
      failures.map((failure) => failure.cause),
      `[eventing] ${failures.length} consumer(s) failed: ${failures
        .map((failure) => failure.consumer)
        .join(", ")}`,
    );
  }

  return { delivered: outcomes.length };
}
