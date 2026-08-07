import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { gmailIngestedTriggerConsumers } from "../../src/composition/gmail-ingested-consumers";
import { registerGmailTriageHandler } from "../../src/modules/integrations/gmail-triage";
import type { DomainEvent } from "../../src/modules/triggers";

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

  test("every consumer ignores a non-batch event without touching a side effect", async () => {
    // The batch consumers share the bus with `message_received` and see the
    // re-entrant emit the triage consumer itself publishes. Each must no-op on
    // any event that is not its Gmail batch fact — otherwise it would recurse or
    // reach for a handler/DB that this test does not wire.
    for (const consumer of gmailIngestedTriggerConsumers()) {
      await assert.doesNotReject(() => consumer.accept(messageReceived));
    }
  });

  test("corpus, user-model, and inbox consumers short-circuit an empty batch", async () => {
    // These three carry an explicit empty-guard, so an empty batch reaches
    // neither corpus, the DB, nor the SSE bus — no handler or DB needed.
    for (const name of ["gmail-corpus-index", "gmail-user-model-capture", "gmail-inbox-rail"]) {
      await assert.doesNotReject(() => consumerNamed(name).accept(emptyBatch()));
    }
  });

  test("triage consumer routes through the triage seam and stays best-effort", async () => {
    // The triage consumer always calls the post-insert triage seam (thread
    // repair runs even with nothing to reconcile). A stub handler stands in for
    // runtime composition; the consumer must resolve, not reject, when its
    // best-effort reactions have nothing to do.
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
