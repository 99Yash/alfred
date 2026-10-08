import { toMessage } from "@alfred/contracts";
import type { DomainEvent, PublishedEvent, TriggerConsumer } from "..";

const consumers = new Map<string, TriggerConsumer>();

/**
 * A boot-wiring failure, not a reaction failure: a handler or the registry was missing.
 * It fails the publish even for `best-effort`, so it shows up on retry. The seam checks `instanceof`.
 */
export abstract class TriggerConsumerBootError extends Error {}

export class NoTriggerConsumersRegisteredError extends TriggerConsumerBootError {
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
  const failures: Array<{ consumer: string; cause: unknown }> = [];
  let acceptedConsumers = 0;

  for (const [index, outcome] of outcomes.entries()) {
    const consumer = registered[index];

    if (outcome.status === "fulfilled") {
      acceptedConsumers += 1;
      continue;
    }

    // `best-effort` failures never fail the publish, except a boot error. `propagate` failures rethrow.
    if (consumer?.mode === "best-effort" && !(outcome.reason instanceof TriggerConsumerBootError)) {
      acceptedConsumers += 1;
      console.warn(
        `[triggers] best-effort consumer '${consumer.name}' failed:`,
        toMessage(outcome.reason),
      );
      continue;
    }

    failures.push({ consumer: consumer?.name ?? "unknown", cause: outcome.reason });
  }

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
