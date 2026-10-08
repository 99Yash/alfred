import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { gmailIngestedTriggerConsumers } from "../../src/runtime/adapters/gmail-ingested-consumers";
import {
  NoGmailTriageHandlerRegisteredError,
  registerGmailTriageHandler,
} from "../../src/connections/ingestion/gmail-triage";
import {
  publishDomainEvent,
  registerTriggerConsumer,
  type DomainEvent,
} from "@alfred/assistant/triggers";

function emptyBatch(): DomainEvent {
  return {
    userId: "user-1",
    source: "gmail",
    type: "documents_ingested",
    eventId: "batch-empty-1",
    payload: {
      credentialId: "credential-1",
      jobKind: "gmail.poll_recent",
      insertedDocumentIds: [],
      triageDocumentIds: [],
      sentDocumentIds: [],
      touchedThreadIds: [],
      unembeddedDocumentIds: [],
    },
  };
}

const messageReceived: DomainEvent = {
  userId: "user-1",
  source: "gmail",
  type: "message_received",
  eventId: "document-1",
  payload: { documentId: "document-1", reason: "webhook" },
};

function consumerNamed(name: string) {
  const consumer = gmailIngestedTriggerConsumers().find((entry) => entry.name === name);
  assert.ok(consumer, `expected a consumer named ${name}`);

  return consumer;
}

/** Register the four batch-fact consumers; returns teardown. */
function registerAllConsumers(): () => void {
  const unregisters = gmailIngestedTriggerConsumers().map((consumer) =>
    registerTriggerConsumer(consumer),
  );

  return () => {
    for (const unregister of unregisters) unregister();
  };
}

describe("gmail documents_ingested consumers", () => {
  test("registers exactly the four batch-fact consumers", () => {
    assert.deepEqual(
      gmailIngestedTriggerConsumers()
        .map((consumer) => consumer.name)
        .sort(),
      [
        "gmail-corpus-index",
        "gmail-inbox-rail",
        "gmail-triage-postinsert",
        "gmail-user-model-capture",
      ],
    );
  });

  test("every consumer registers as best-effort so the seam owns the swallow", () => {
    for (const consumer of gmailIngestedTriggerConsumers()) {
      assert.equal(consumer.mode, "best-effort", `${consumer.name} must be best-effort`);
    }
  });

  test("a throwing reaction is swallowed by the seam, not the body", async () => {
    // A plain error from a best-effort consumer is swallowed by the seam.
    const originalWarn = console.warn;
    console.warn = () => {};

    const unregisterHandler = registerGmailTriageHandler({
      async postInsert() {
        throw new Error("triage repair unavailable");
      },
      async relabel() {
        return { applied: false, reason: "document-not-found" };
      },
    });

    const unregisterConsumers = registerAllConsumers();

    try {
      await assert.doesNotReject(() => publishDomainEvent(emptyBatch()));
    } finally {
      unregisterConsumers();
      unregisterHandler();
      console.warn = originalWarn;
    }
  });

  test("a boot-wiring failure still rejects the publish even from a best-effort consumer", async () => {
    // A missing handler is a TriggerConsumerBootError: it must fail the job.
    const unregisterConsumers = registerAllConsumers();

    try {
      await assert.rejects(
        publishDomainEvent(emptyBatch()),
        (error: unknown) =>
          error instanceof AggregateError &&
          error.errors.some((cause) => cause instanceof NoGmailTriageHandlerRegisteredError),
      );
    } finally {
      unregisterConsumers();
    }
  });

  test("every consumer ignores a non-batch event without touching a side effect", async () => {
    // Each consumer must no-op on any other event, or it recurses on the triage re-emit.
    for (const consumer of gmailIngestedTriggerConsumers()) {
      await assert.doesNotReject(() => consumer.accept(messageReceived));
    }
  });

  test("corpus, user-model, and inbox consumers short-circuit an empty batch", async () => {
    // These three return early on an empty batch.
    for (const name of ["gmail-corpus-index", "gmail-user-model-capture", "gmail-inbox-rail"]) {
      await assert.doesNotReject(() => consumerNamed(name).accept(emptyBatch()));
    }
  });

  test("triage consumer routes through the triage seam and stays best-effort", async () => {
    // The triage consumer always calls the seam, since thread repair runs on an empty batch too.
    const unregister = registerGmailTriageHandler({
      async postInsert() {
        return { replyReevalTargets: [] };
      },
      async relabel() {
        return { applied: false, reason: "document-not-found" };
      },
    });

    try {
      await assert.doesNotReject(() =>
        consumerNamed("gmail-triage-postinsert").accept(emptyBatch()),
      );
    } finally {
      unregister();
    }
  });
});
