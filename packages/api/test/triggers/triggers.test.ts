import assert from "node:assert/strict";
import { describe, test } from "node:test";
import {
  domainEventSchema,
  NoTriggerConsumersRegisteredError,
  publishDomainEvent,
  registerTriggerConsumer,
} from "../../src/modules/triggers";

const event = {
  userId: "user-1",
  source: "gmail" as const,
  type: "message_received" as const,
  eventId: "message-1",
  payload: { documentId: "document-1" },
};

describe("triggers", () => {
  test("publishes one event to every registered consumer", async () => {
    const received: string[] = [];
    const unregisterFirst = registerTriggerConsumer({
      name: "triggers-test-first",
      accept: async (published) => {
        received.push(`first:${published.eventId}`);
      },
    });
    const unregisterSecond = registerTriggerConsumer({
      name: "triggers-test-second",
      accept: async (published) => {
        received.push(`second:${published.eventId}`);
      },
    });

    try {
      const result = await publishDomainEvent(event);
      assert.deepEqual(result, { acceptedConsumers: 2 });
      assert.deepEqual(received.sort(), ["first:message-1", "second:message-1"]);
    } finally {
      unregisterFirst();
      unregisterSecond();
    }
  });

  test("rejects invalid source, type, identity, and payload fields", () => {
    assert.equal(domainEventSchema.safeParse({ ...event, type: "completed" }).success, false);
    assert.equal(domainEventSchema.safeParse({ ...event, userId: "" }).success, false);
    assert.equal(
      domainEventSchema.safeParse({ ...event, payload: { documentId: 42 } }).success,
      false,
    );
    assert.equal(
      domainEventSchema.safeParse({ ...event, payload: { extra: true } }).success,
      false,
    );
    assert.equal(
      domainEventSchema.safeParse({
        ...event,
        source: "google.oauth.callback",
        type: "completed",
        payload: { workflowId: "workflow-1" },
      }).success,
      true,
    );
  });

  test("rejects publication when runtime composition registered no consumer", async () => {
    await assert.rejects(
      publishDomainEvent(event),
      (error: unknown) => error instanceof NoTriggerConsumersRegisteredError,
    );
  });

  test("lets every consumer claim an event before reporting failures", async () => {
    let successfulConsumerRan = false;
    const unregisterFailure = registerTriggerConsumer({
      name: "triggers-test-failure",
      accept: async () => {
        throw new Error("consumer failed");
      },
    });
    const unregisterSuccess = registerTriggerConsumer({
      name: "triggers-test-success",
      accept: async () => {
        successfulConsumerRan = true;
      },
    });

    try {
      await assert.rejects(publishDomainEvent(event), /triggers-test-failure/);
      assert.equal(successfulConsumerRan, true);
    } finally {
      unregisterFailure();
      unregisterSuccess();
    }
  });

  test("counts a consumer that returns a domain failure as accepted", async () => {
    const unregister = registerTriggerConsumer({
      name: "triggers-test-domain-failure",
      accept: async () => ({ failed: 1 }),
    });

    try {
      assert.deepEqual(await publishDomainEvent(event), { acceptedConsumers: 1 });
    } finally {
      unregister();
    }
  });
});
