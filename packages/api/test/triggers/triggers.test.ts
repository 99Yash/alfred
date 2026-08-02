import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { domainEventSchema, publish, registerTriggerConsumer } from "../../src/modules/triggers";

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
      const result = await publish(event);
      assert.deepEqual(result, { delivered: 2 });
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
  });

  test("rejects publication when runtime composition registered no consumer", async () => {
    await assert.rejects(publish(event), /no consumers are registered/);
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
      await assert.rejects(publish(event), /triggers-test-failure/);
      assert.equal(successfulConsumerRan, true);
    } finally {
      unregisterFailure();
      unregisterSuccess();
    }
  });
});
