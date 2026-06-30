import assert from "node:assert/strict";
import { describe, test } from "node:test";
import {
  gmailEmailMessagePayloadSchema,
  identityRefSchema,
  type IdentityRef,
} from "@alfred/contracts";
import type { Observation } from "@alfred/db/schemas";
import { classifyEntityKind } from "../../src/modules/user-model/entity-kind-classifier";

const OCCURRED_AT = new Date("2026-06-30T08:00:00.000Z");

describe("classifyEntityKind", () => {
  test("uses List-Id as authoritative group evidence", () => {
    const result = classifyEntityKind({
      identity: emailIdentity("engineering@oliv.ai"),
      displayNames: ["Anthropic via Engineering"],
      payloadSignals: [{ listId: "Engineering <engineering.oliv.ai>" }],
    });

    assert.equal(result.kind, "group");
    assert.equal(result.confidence, 0.99);
    assert.deepEqual(result.evidenceCodes, ["gmail:list_id"]);
  });

  test("uses bulk/list precedence and List-Unsubscribe as authoritative group evidence", () => {
    const result = classifyEntityKind({
      identity: emailIdentity("updates@example.com"),
      payloadSignals: [{ precedence: "bulk", listUnsubscribe: "<mailto:off@example.com>" }],
    });

    assert.equal(result.kind, "group");
    assert.equal(result.confidence, 0.99);
    assert.deepEqual(result.evidenceCodes, [
      "gmail:list_unsubscribe",
      "gmail:precedence:bulk",
    ]);
  });

  test("classifies no-reply and notification senders as services", () => {
    assert.equal(classifyEntityKind({ identity: emailIdentity("noreply@github.com") }).kind, "service");
    assert.equal(
      classifyEntityKind({ identity: emailIdentity("notifications@tasks.clickup.com") }).kind,
      "service",
    );
  });

  test("keeps a human-looking mailbox on a service domain as a person", () => {
    const result = classifyEntityKind({
      identity: emailIdentity("jane.doe@google.com"),
      displayNames: ["Jane Doe"],
    });

    assert.equal(result.kind, "person");
    assert.deepEqual(result.evidenceCodes, ["display:person_like"]);
  });

  test("does not person-score weak group aliases without header evidence", () => {
    const result = classifyEntityKind({
      identity: emailIdentity("team@startup.example"),
      displayNames: ["Team"],
    });

    assert.equal(result.kind, "unknown");
    assert.equal(result.bestGuess, "group");
    assert.ok(result.confidence < 0.7);
    assert.deepEqual(result.evidenceCodes, ["email:local:group_weak"]);
  });

  test("classifies plain individual mailboxes as people", () => {
    const result = classifyEntityKind({
      identity: emailIdentity("alice@example.com"),
      displayNames: ["Alice Example"],
    });

    assert.equal(result.kind, "person");
    assert.equal(result.confidence, 0.82);
  });

  test("classifies non-email hard identities by their identity kind", () => {
    assert.equal(classifyEntityKind({ identity: domainIdentity("oliv.ai") }).kind, "organization");
    assert.equal(
      classifyEntityKind({ identity: identity("github_repository_full_name", "99yash/alfred") }).kind,
      "repository",
    );
  });

  test("extracts Gmail payload signals from observations", () => {
    const result = classifyEntityKind({
      identity: emailIdentity("engineering@oliv.ai"),
      observations: [gmailObservation({ listId: "Engineering <engineering.oliv.ai>" })],
    });

    assert.equal(result.kind, "group");
    assert.deepEqual(result.evidenceCodes, ["gmail:list_id"]);
  });
});

function emailIdentity(value: string): IdentityRef {
  return identity("email", value.toLowerCase());
}

function domainIdentity(value: string): IdentityRef {
  return identity("domain", value.toLowerCase());
}

function identity(kind: IdentityRef["kind"], value: string): IdentityRef {
  return identityRefSchema.parse({ kind, value });
}

function gmailObservation(overrides: {
  readonly listId?: string | null;
  readonly precedence?: string | null;
  readonly autoSubmitted?: string | null;
}): Observation {
  const sender = emailIdentity("engineering@oliv.ai");
  const payload = gmailEmailMessagePayloadSchema.parse({
    provider: "gmail",
    documentId: "doc_1",
    messageId: "gmail_msg_1",
    threadId: "gmail_thread_1",
    accountId: "acct_1",
    isSent: false,
    subject: "Update",
    subjectHash: "sha256:abc",
    headers: {
      messageId: "<m1@example.com>",
      inReplyTo: null,
      references: [],
      listId: overrides.listId ?? null,
      replyTo: null,
      deliveredTo: null,
      autoSubmitted: overrides.autoSubmitted ?? null,
      precedence: overrides.precedence ?? null,
    },
  });

  return {
    id: "obs_1",
    userId: "usr_1",
    source: "gmail",
    kind: "email_message",
    occurredAt: OCCURRED_AT,
    familyKey: "gmail:message:acct_1:gmail_msg_1",
    evidenceHash: "sha256:abc",
    subjectIdentity: sender,
    objectIdentity: null,
    participants: {
      items: [{ identity: sender, role: "from", displayName: "Engineering" }],
      recipientCount: 0,
      ...(overrides.listId ? { listId: overrides.listId } : {}),
    },
    payload,
    schemaVersion: 1,
    reducerVersion: 1,
    supersedesObservationId: null,
    createdAt: OCCURRED_AT,
    updatedAt: OCCURRED_AT,
  };
}
