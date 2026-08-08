import assert from "node:assert/strict";
import { describe, test } from "node:test";
import {
  domainEventSchema,
  NoTriggerConsumersRegisteredError,
  publishDomainEvent,
  registerTriggerConsumer,
} from "../src/triggers";

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
      mode: "propagate",
      accept: async (published) => {
        received.push(`first:${published.eventId}`);
      },
    });
    const unregisterSecond = registerTriggerConsumer({
      name: "triggers-test-second",
      mode: "propagate",
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

  test("lets every consumer claim an event before reporting a propagate failure", async () => {
    let successfulConsumerRan = false;
    const unregisterFailure = registerTriggerConsumer({
      name: "triggers-test-failure",
      mode: "propagate",
      accept: async () => {
        throw new Error("consumer failed");
      },
    });
    const unregisterSuccess = registerTriggerConsumer({
      name: "triggers-test-success",
      mode: "propagate",
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

  test("swallows a best-effort consumer's non-boot failure and still resolves", async () => {
    let siblingRan = false;
    const warnings: unknown[][] = [];
    const originalWarn = console.warn;
    console.warn = (...args: unknown[]) => warnings.push(args);
    const unregisterFailure = registerTriggerConsumer({
      name: "triggers-test-best-effort-failure",
      mode: "best-effort",
      accept: async () => {
        throw new Error("reaction failed");
      },
    });
    const unregisterSibling = registerTriggerConsumer({
      name: "triggers-test-best-effort-sibling",
      mode: "best-effort",
      accept: async () => {
        siblingRan = true;
      },
    });

    try {
      // The failing reaction is counted as accepted and logged; the publish
      // resolves so the job that awaited it is never rolled back, and the
      // sibling still ran.
      assert.deepEqual(await publishDomainEvent(event), { acceptedConsumers: 2 });
      assert.equal(siblingRan, true);
      assert.match(String(warnings[0]?.[0]), /triggers-test-best-effort-failure/);
    } finally {
      unregisterFailure();
      unregisterSibling();
      console.warn = originalWarn;
    }
  });

  test("re-throws a boot error even from a best-effort consumer", async () => {
    // A boot-wiring failure must fail the publish regardless of mode, so a broken
    // boot path surfaces on retry instead of being silently swallowed.
    const unregister = registerTriggerConsumer({
      name: "triggers-test-best-effort-boot",
      mode: "best-effort",
      accept: async () => {
        throw new NoTriggerConsumersRegisteredError();
      },
    });

    try {
      await assert.rejects(
        publishDomainEvent(event),
        (error: unknown) =>
          error instanceof AggregateError &&
          error.errors.some((cause) => cause instanceof NoTriggerConsumersRegisteredError),
      );
    } finally {
      unregister();
    }
  });

  test("validates the gmail.documents_ingested batch payload by type", () => {
    const batch = {
      userId: "user-1",
      source: "gmail" as const,
      type: "documents_ingested" as const,
      eventId: "batch-1",
      payload: {
        credentialId: "credential-1",
        jobKind: "gmail.poll_recent",
        insertedDocumentIds: ["doc-1"],
        triageDocumentIds: ["doc-1"],
        sentDocumentIds: [],
        touchedThreadIds: ["thread-1"],
        unembeddedDocumentIds: ["doc-1"],
      },
    };

    assert.equal(domainEventSchema.safeParse(batch).success, true);
    // Strict: an unknown key is rejected at the publish boundary.
    assert.equal(
      domainEventSchema.safeParse({ ...batch, payload: { ...batch.payload, extra: true } }).success,
      false,
    );
    // A missing required array is rejected.
    const { unembeddedDocumentIds: _omit, ...withoutUnembedded } = batch.payload;
    assert.equal(
      domainEventSchema.safeParse({ ...batch, payload: withoutUnembedded }).success,
      false,
    );
    // An unknown jobKind is rejected.
    assert.equal(
      domainEventSchema.safeParse({
        ...batch,
        payload: { ...batch.payload, jobKind: "gmail.made_up" },
      }).success,
      false,
    );
    // The schema is chosen by `type`: the message payload does not satisfy the
    // batch type, and the batch payload does not satisfy `message_received`.
    assert.equal(
      domainEventSchema.safeParse({ ...batch, payload: { documentId: "doc-1" } }).success,
      false,
    );
    assert.equal(
      domainEventSchema.safeParse({ ...event, type: "documents_ingested" }).success,
      false,
    );
  });

  test("counts a consumer that returns a domain failure as accepted", async () => {
    const unregister = registerTriggerConsumer({
      name: "triggers-test-domain-failure",
      mode: "propagate",
      accept: async () => ({ failed: 1 }),
    });

    try {
      assert.deepEqual(await publishDomainEvent(event), { acceptedConsumers: 1 });
    } finally {
      unregister();
    }
  });
});
