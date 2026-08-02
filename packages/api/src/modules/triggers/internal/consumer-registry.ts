import type { DomainEvent, PublishedEvent, TriggerConsumer } from "..";

const consumers = new Map<string, TriggerConsumer>();

export class NoTriggerConsumersRegisteredError extends Error {
  constructor() {
    super("[triggers] no consumers are registered");
    this.name = "NoTriggerConsumersRegisteredError";
  }
}

export function registerConsumer(consumer: TriggerConsumer): () => void {
  if (consumers.has(consumer.name)) {
    throw new Error(`[triggers] consumer '${consumer.name}' is already registered`);
  }
  consumers.set(consumer.name, consumer);

  return () => {
    if (consumers.get(consumer.name) === consumer) consumers.delete(consumer.name);
  };
}

export async function publishToConsumers(event: DomainEvent): Promise<PublishedEvent> {
  const registered = [...consumers.values()];
  if (registered.length === 0) {
    throw new NoTriggerConsumersRegisteredError();
  }
  const outcomes = await Promise.allSettled(registered.map((consumer) => consumer.accept(event)));
  const acceptedConsumers = outcomes.filter((outcome) => outcome.status === "fulfilled").length;
  const failures = outcomes.flatMap((outcome, index) =>
    outcome.status === "rejected"
      ? [{ consumer: registered[index]?.name ?? "unknown", cause: outcome.reason }]
      : [],
  );

  if (failures.length > 0) {
    throw new AggregateError(
      failures.map((failure) => failure.cause),
      `[triggers] ${failures.length} consumer(s) failed: ${failures
        .map((failure) => failure.consumer)
        .join(", ")}`,
    );
  }

  return { acceptedConsumers };
}
